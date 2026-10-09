import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProgress } from "@houchi/database";
import { createTestDb } from "@houchi/database/testing";
import { createAuth } from "@houchi/web/auth";
import { StubProvider } from "@houchi/providers";
import { createApp, type FetchHandler } from "@houchi/web";
import { ApiClient } from "../src/api.js";
import { tick, type RunnerDeps } from "../src/loop.js";

/**
 * 実行体 E2E: 実際の Web API (createApp + better-sqlite3) を
 * node:http で立て、runner の tick を通す。
 */

const SECRET_KEY = btoa("0123456789abcdef0123456789abcdef");
const TOKEN = "tok-e2e";

let server: Server;
let baseUrl: string;
let db: ReturnType<typeof createTestDb>;
let api: ApiClient;
const logs: string[] = [];

function serve(app: FetchHandler): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const request = new Request(`http://x${req.url}`, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        ...(body.length > 0 ? { body } : {}),
      });
      void app(request).then(async (r) => {
        res.writeHead(r.status, {
          "content-type": r.headers.get("content-type") ?? "application/json",
        });
        res.end(await r.text());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    api,
    executorId: "e2e-1",
    leaseTtlMs: 60_000,
    providers: { openai: new StubProvider({ text: "stub-output" }) },
    log: (m) => logs.push(m),
    ...overrides,
  };
}

const PAYLOAD = {
  model: "m",
  input: [{ role: "user", content: "テスト" }],
  provider: "stub",
};

beforeEach(async () => {
  db = createTestDb();
  const auth = createAuth(db, {
    baseUrl: "http://localhost",
    secret: SECRET_KEY,
    devLoginEnabled: false,
  });
  const app = createApp({
    db,
    secretKey: SECRET_KEY,
    executorToken: TOKEN,
    auth,
    devLoginEnabled: false,
    defaultModel: "stub",
    baseUrl: "http://localhost",
  });
  await serve(app);
  api = new ApiClient(baseUrl, TOKEN);
  logs.length = 0;
});

afterEach(() => {
  server.close();
});

describe("runner e2e", () => {
  it("lease → progress → complete の流れが動く", async () => {
    const { job } = await api.createJob({
      kind: "smoke_generate",
      payload: PAYLOAD,
      idempotency_key: "e2e-1",
    });

    const stub = new StubProvider({ text: "hello world" });
    const worked = await tick(
      makeDeps({ providers: { openai: stub, stub } }),
    );
    expect(worked).toBe(true);
    expect(stub.calls).toBe(1);

    const { job: done } = await api.getJob(job.id);
    expect(done.status).toBe("completed");
    expect(done.result).toMatchObject({
      kind: "smoke_generate",
      output_text: "hello world",
      resumed_from_checkpoint: false,
    });

    // progress イベントが永続化されている (status 遷移のみ確認)
    const events = await listProgress(db, job.id);
    const steps = events.map((e) => (e.data as { step?: string }).step);
    expect(steps).toEqual(
      expect.arrayContaining(["call_provider", "persist_result", "complete"]),
    );
  });

  it("キューが空なら tick は false", async () => {
    expect(await tick(makeDeps())).toBe(false);
  });

  it("途中kill → 期限切れ → 再リースで checkpoint から完了 (provider再呼出しなし)", async () => {
    const { job } = await api.createJob({
      kind: "smoke_generate",
      payload: PAYLOAD,
      idempotency_key: "e2e-2",
    });
    const stub = new StubProvider({ text: "resumed" });

    // 1回目: complete 呼び出しが1回だけ失敗するクラッシュを再現。
    const crashingApi = new ApiClient(baseUrl, TOKEN);
    let completed = false;
    const origComplete = crashingApi.complete.bind(crashingApi);
    crashingApi.complete = async (id, req) => {
      if (!completed) {
        completed = true;
        throw new Error("simulated runner crash");
      }
      return origComplete(id, req);
    };

    await expect(
      tick(makeDeps({ api: crashingApi, providers: { openai: stub, stub } })),
    ).resolves.toBe(true);
    expect(stub.calls).toBe(1);
    // ジョブは leased のまま (失敗マークされていない)
    expect((await api.getJob(job.id)).job.status).toBe("leased");

    // リースを強制期限切れにして別実行体が再リースする状況を作る。
    await db.run(
      sql`UPDATE agent_jobs SET lease_expires_at = 0 WHERE id = ${job.id}`,
    );
    const worked = await tick(
      makeDeps({ executorId: "e2e-2", providers: { openai: stub, stub } }),
    );
    expect(worked).toBe(true);

    const { job: done } = await api.getJob(job.id);
    expect(done.status).toBe("completed");
    expect(done.result).toMatchObject({
      output_text: "resumed",
      resumed_from_checkpoint: true,
    });
    // 核心: provider は2回目に再呼出しされない。
    expect(stub.calls).toBe(1);
  });

  it("key_ref 経路: 登録キーを復号して使う", async () => {
    const { key } = await api.createKey({
      owner_ref: "u",
      label: "l",
      api_key: "sk-key-xyz",
    });
    const { job } = await api.createJob({
      kind: "smoke_generate",
      payload: { ...PAYLOAD, provider: "openai", key_ref: key.id },
      idempotency_key: "e2e-3",
      user_ref: "u",
    });
    // OpenAI プロバイダーを偽装するスタブ (requiresKey=true 相当に見せる)
    const keyAware = new StubProvider({ text: "with-key" });
    Object.defineProperty(keyAware, "requiresKey", { value: true });
    const worked = await tick(makeDeps({ providers: { openai: keyAware } }));
    expect(worked).toBe(true);
    expect((await api.getJob(job.id)).job.status).toBe("completed");
  });
});
