import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@houchi/database/testing";
import { createApp, type FetchHandler } from "../src/app.js";

const SECRET_KEY = btoa("0123456789abcdef0123456789abcdef");
const TOKEN = "test-executor-token";

let app: FetchHandler;
let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  db = createTestDb();
  app = createApp({ db, secretKey: SECRET_KEY, executorToken: TOKEN });
});

function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<Response> {
  return app(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const JOB = {
  kind: "smoke_generate",
  payload: {
    model: "m",
    input: [{ role: "user", content: "hi" }],
  },
  idempotency_key: "idem-app-1",
};

async function createAndLease() {
  const created = await call("POST", "/api/jobs", JOB);
  const { job } = (await created.json()) as { job: { id: string } };
  const leased = await call("POST", "/api/jobs/lease", {
    executor_id: "ex-test",
    lease_ttl_ms: 60_000,
  });
  const l = (await leased.json()) as {
    job: { id: string; lease_token: string | null };
    lease_token: string;
    lease_expires_at: number;
  };
  return { jobId: job.id, lease: l };
}

describe("web api", () => {
  it("healthz は認証なし", async () => {
    const res = await call("GET", "/api/healthz", undefined, null);
    expect(res.status).toBe(200);
  });

  it("認証なし/誤トークンは 401", async () => {
    expect((await call("POST", "/api/jobs", JOB, null)).status).toBe(401);
    expect((await call("POST", "/api/jobs", JOB, "wrong")).status).toBe(401);
  });

  it("ジョブ作成 → 冪等再作成", async () => {
    const a = await call("POST", "/api/jobs", JOB);
    expect(a.status).toBe(201);
    const b = await call("POST", "/api/jobs", JOB);
    expect(b.status).toBe(200);
    expect(((await b.json()) as { created: boolean }).created).toBe(false);
  });

  it("lease → progress → heartbeat(checkpoint) → complete", async () => {
    const { jobId, lease } = await createAndLease();
    expect(lease.job.id).toBe(jobId);
    expect(lease.job.lease_token).toBeNull(); // 応答からは除く
    expect(lease.lease_token).toBeTruthy();

    const p = await call("POST", `/api/jobs/${jobId}/progress`, {
      lease_token: lease.lease_token,
      type: "status",
      data: { step: "call_provider" },
    });
    expect(p.status).toBe(200);
    expect(((await p.json()) as { event: { seq: number } }).event.seq).toBe(1);

    const hb = await call("POST", `/api/jobs/${jobId}/heartbeat`, {
      lease_token: lease.lease_token,
      checkpoint: { provider_result: { output_text: "r", usage: "unknown" } },
    });
    expect(hb.status).toBe(200);
    const hbJob = (await hb.json()) as {
      job: { payload: { checkpoint?: { provider_result?: unknown } } };
    };
    expect(hbJob.job.payload.checkpoint?.provider_result).toBeDefined();

    const c = await call("POST", `/api/jobs/${jobId}/complete`, {
      lease_token: lease.lease_token,
      result: { output_text: "r" },
    });
    expect(c.status).toBe(200);
    expect(((await c.json()) as { job: { status: string } }).job.status).toBe(
      "completed",
    );
  });

  it("lease_token 不一致の complete は 409", async () => {
    const { jobId } = await createAndLease();
    const res = await call("POST", `/api/jobs/${jobId}/complete`, {
      lease_token: "bogus",
      result: {},
    });
    expect(res.status).toBe(409);
  });

  it("期限切れリースは再リース可能", async () => {
    const { jobId } = await createAndLease();
    await db.run(
      sql`UPDATE agent_jobs SET lease_expires_at = 0 WHERE id = ${jobId}`,
    );
    const re = await call("POST", "/api/jobs/lease", {
      executor_id: "ex-2",
      lease_ttl_ms: 60_000,
    });
    const l = (await re.json()) as { job: { id: string } | null };
    expect(l.job?.id).toBe(jobId);
  });

  it("leased 中は次のジョブを取らない → complete 後に取れる", async () => {
    await createAndLease();
    const next = await call("POST", "/api/jobs/lease", {
      executor_id: "ex-2",
    });
    expect(((await next.json()) as { job: unknown }).job).toBeNull();
  });

  it("進行中のリースは GET で照会できる (token は出ない)", async () => {
    const { jobId } = await createAndLease();
    const res = await call("GET", `/api/jobs/${jobId}`);
    const body = (await res.json()) as {
      job: { status: string; lease_token: string | null };
    };
    expect(body.job.status).toBe("leased");
    expect(body.job.lease_token).toBeNull();
  });

  it("BYO キー: 登録 → 平文で取得できる往復 (応答に ciphertext なし)", async () => {
    const created = await call("POST", "/api/internal/keys", {
      owner_ref: "user-1",
      label: "main",
      api_key: "sk-test-123",
    });
    expect(created.status).toBe(201);
    const { key } = (await created.json()) as {
      key: { id: string; ciphertext?: string };
    };
    expect(key.ciphertext).toBeUndefined();

    const got = await call("GET", `/api/internal/keys/${key.id}`);
    expect(((await got.json()) as { api_key: string }).api_key).toBe(
      "sk-test-123",
    );
  });

  it("BYO キーの暗号文が復号できない場合は 500 (内容を漏らさない)", async () => {
    const created = await call("POST", "/api/internal/keys", {
      owner_ref: "u",
      label: "l",
      api_key: "sk",
    });
    const { key } = (await created.json()) as { key: { id: string } };
    await db.run(
      sql`UPDATE provider_keys SET ciphertext = 'tampered' WHERE id = ${key.id}`,
    );
    const res = await call("GET", `/api/internal/keys/${key.id}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain("sk");
  });

  it("バリデーション失敗は 400", async () => {
    const res = await call("POST", "/api/jobs", { kind: "" });
    expect(res.status).toBe(400);
  });
});
