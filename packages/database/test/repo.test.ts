import { describe, expect, it } from "vitest";
import {
  appendProgress,
  completeJob,
  createJob,
  createKey,
  failJob,
  getJob,
  getJobByIdempotencyKey,
  getKeyById,
  heartbeat,
  leaseNextJob,
  listProgress,
  RepoError,
} from "../src/index.js";
import { createTestDb } from "../src/testing.js";

const JOB = {
  kind: "smoke_generate",
  payload: { model: "m", input: [{ role: "user", content: "hi" }] },
  idempotencyKey: "idem-1",
};

describe("repo", () => {
  it("createJob → getJob の往復", async () => {
    const db = createTestDb();
    const { job, created } = await createJob(db, JOB);
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect((await getJob(db, job.id))?.id).toBe(job.id);
  });

  it("idempotency_key 重複は既存を返し二重作成しない", async () => {
    const db = createTestDb();
    const a = await createJob(db, JOB);
    const b = await createJob(db, { ...JOB, payload: { different: true } });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.payload).toEqual(JOB.payload);
    expect(await getJobByIdempotencyKey(db, "idem-1")).not.toBeNull();
  });

  it("lease → complete (lease_token 必須)", async () => {
    const db = createTestDb();
    await createJob(db, JOB);
    const lease = await leaseNextJob(db, { executorId: "ex-1" });
    expect(lease).not.toBeNull();
    expect(lease!.job.status).toBe("leased");
    expect(lease!.job.attempts).toBe(1);
    const done = await completeJob(db, {
      jobId: lease!.job.id,
      leaseToken: lease!.leaseToken,
      result: { output_text: "hi" },
    });
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ output_text: "hi" });
  });

  it("キューが空なら lease は null", async () => {
    const db = createTestDb();
    expect(await leaseNextJob(db, { executorId: "ex-1" })).toBeNull();
  });

  it("leased 中のジョブは再リースされない", async () => {
    const db = createTestDb();
    await createJob(db, JOB);
    const a = await leaseNextJob(db, { executorId: "ex-1" });
    const b = await leaseNextJob(db, { executorId: "ex-2" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("期限切れリースは再取得できる", async () => {
    const db = createTestDb();
    await createJob(db, JOB);
    const a = await leaseNextJob(db, {
      executorId: "ex-1",
      leaseTtlMs: -1, // 即期限切れ
    });
    expect(a).not.toBeNull();
    const b = await leaseNextJob(db, { executorId: "ex-2" });
    expect(b).not.toBeNull();
    expect(b!.job.id).toBe(a!.job.id);
    expect(b!.job.attempts).toBe(2);
    expect(b!.job.leased_by).toBe("ex-2");
  });

  it("同一 work_ref の leased ジョブがある間は同 work_ref をリースしない (直列化)", async () => {
    const db = createTestDb();
    await createJob(db, { ...JOB, workRef: "w1", idempotencyKey: "a" });
    await createJob(db, { ...JOB, workRef: "w1", idempotencyKey: "b" });
    const first = await leaseNextJob(db, { executorId: "ex-1" });
    expect(first!.job.work_ref).toBe("w1");
    expect(await leaseNextJob(db, { executorId: "ex-2" })).toBeNull();
  });

  it("work_ref が違えば並行リースできる", async () => {
    const db = createTestDb();
    await createJob(db, { ...JOB, workRef: "w1", idempotencyKey: "a" });
    await createJob(db, { ...JOB, workRef: "w2", idempotencyKey: "b" });
    expect(await leaseNextJob(db, { executorId: "ex-1" })).not.toBeNull();
    const second = await leaseNextJob(db, { executorId: "ex-2" });
    expect(second).not.toBeNull();
    expect(second!.job.work_ref).toBe("w2");
  });

  it("complete は lease_token 不一致を拒否する", async () => {
    const db = createTestDb();
    await createJob(db, JOB);
    const lease = await leaseNextJob(db, { executorId: "ex-1" });
    try {
      await completeJob(db, {
        jobId: lease!.job.id,
        leaseToken: "wrong-token",
        result: {},
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RepoError);
      expect((e as RepoError).code).toBe("lease_conflict");
    }
    expect((await getJob(db, lease!.job.id))!.status).toBe("leased");
  });

  it("期限切れリースでは complete できない", async () => {
    const db = createTestDb();
    await createJob(db, JOB);
    const lease = await leaseNextJob(db, {
      executorId: "ex-1",
      leaseTtlMs: -1,
    });
    await expect(
      completeJob(db, {
        jobId: lease!.job.id,
        leaseToken: lease!.leaseToken,
        result: {},
      }),
    ).rejects.toMatchObject({ code: "lease_conflict" });
  });

  it("appendProgress は連番 seq を振りリース検証する", async () => {
    const db = createTestDb();
    const { job } = await createJob(db, JOB);
    await expect(
      appendProgress(db, {
        jobId: job.id,
        leaseToken: "x",
        type: "status",
        data: {},
      }),
    ).rejects.toMatchObject({ code: "lease_conflict" });

    const lease = await leaseNextJob(db, { executorId: "ex" });
    const e1 = await appendProgress(db, {
      jobId: job.id,
      leaseToken: lease!.leaseToken,
      type: "status",
      data: { step: "a" },
    });
    const e2 = await appendProgress(db, {
      jobId: job.id,
      leaseToken: lease!.leaseToken,
      type: "token",
      data: { text: "t" },
    });
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    const events = await listProgress(db, job.id);
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toEqual({ text: "t" });
  });

  it("heartbeat はリース延長し checkpoint を payload へマージする", async () => {
    const db = createTestDb();
    const { job } = await createJob(db, JOB);
    const lease = await leaseNextJob(db, { executorId: "ex" });
    const updated = await heartbeat(db, {
      jobId: job.id,
      leaseToken: lease!.leaseToken,
      checkpoint: { provider_result: { output_text: "r", usage: "unknown" } },
    });
    expect(updated.payload.checkpoint).toEqual({
      provider_result: { output_text: "r", usage: "unknown" },
    });
    const refetched = await getJob(db, job.id);
    expect(
      (refetched!.payload.checkpoint as Record<string, unknown>)
        .provider_result,
    ).toEqual({ output_text: "r", usage: "unknown" });
  });

  it("failJob は status=failed にする", async () => {
    const db = createTestDb();
    const { job } = await createJob(db, JOB);
    const lease = await leaseNextJob(db, { executorId: "ex" });
    const f = await failJob(db, {
      jobId: job.id,
      leaseToken: lease!.leaseToken,
      error: "boom",
    });
    expect(f.status).toBe("failed");
    expect(f.error).toBe("boom");
  });

  it("provider_keys の作成と取得", async () => {
    const db = createTestDb();
    const k = await createKey(db, {
      ownerRef: "user-1",
      label: "main",
      ciphertext: "iv.ct",
    });
    expect(k.id).toBeTruthy();
    expect((await getKeyById(db, k.id))?.ciphertext).toBe("iv.ct");
  });
});
