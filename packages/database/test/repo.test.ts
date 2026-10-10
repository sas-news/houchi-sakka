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

// ---------------------------------------------------------------------------
// Phase 1b: 話・シーン・契約・正典・提案
// ---------------------------------------------------------------------------

import {
  addCanonFacts,
  createEpisode,
  createProposal,
  createScene,
  createSceneRevision,
  createWritingContract,
  getLatestContractByScene,
  getLatestEpisode,
  getProposalById,
  listCanonFactsByWork,
  listRevisionsByScene,
  listScenesByWork,
  updateSceneStatus,
} from "../src/index.js";

describe("Phase 1b エンティティ", () => {
  it("episode 自動作成 → シーン → 契約の順で作れる", async () => {
    const db = createTestDb();
    const ep = await createEpisode(db, { workId: "w1", title: "第1話" });
    expect(ep.ord).toBe(1);
    const scene = await createScene(db, {
      episodeId: ep.id,
      title: "冒頭",
      purpose: "導入",
      status: "proposed",
    });
    expect(scene.ord).toBe(1);
    const contract = await createWritingContract(db, {
      sceneId: scene.id,
      status: "draft",
      payload: { role: "導入", pov: "三人称" },
    });
    expect(contract.status).toBe("draft");
    expect(await getLatestEpisode(db, "w1")).toMatchObject({ title: "第1話" });
    expect(await getLatestContractByScene(db, scene.id)).toMatchObject({
      id: contract.id,
    });
    const scenes = await listScenesByWork(db, "w1");
    expect(scenes.map((s) => s.title)).toEqual(["冒頭"]);
    const updated = await updateSceneStatus(db, {
      id: scene.id,
      status: "approved",
    });
    expect(updated!.status).toBe("approved");
  });

  it("scene_revisions は rev_no が最大+1で増える", async () => {
    const db = createTestDb();
    const ep = await createEpisode(db, { workId: "w1", title: "第1話" });
    const scene = await createScene(db, {
      episodeId: ep.id,
      title: "冒頭",
      purpose: "",
      status: "approved",
    });
    const r1 = await createSceneRevision(db, {
      sceneId: scene.id,
      contentJson: { type: "doc", content: [] },
      source: "ai",
      jobId: "j1",
    });
    const r2 = await createSceneRevision(db, {
      sceneId: scene.id,
      contentJson: { type: "doc", content: [] },
      source: "manual_edit",
    });
    expect(r1.rev_no).toBe(1);
    expect(r2.rev_no).toBe(2);
    const revs = await listRevisionsByScene(db, scene.id);
    expect(revs.map((r) => r.rev_no)).toEqual([1, 2]);
  });

  it("canon_facts は statement 完全一致を重複スキップする", async () => {
    const db = createTestDb();
    const first = await addCanonFacts(db, {
      workId: "w1",
      statements: ["主人公は少女", "汽車は止まっている"],
      provenance: "orchestrator",
    });
    expect(first.added).toBe(2);
    const second = await addCanonFacts(db, {
      workId: "w1",
      statements: ["主人公は少女", "雨がやんだ"],
      provenance: "orchestrator",
    });
    expect(second.added).toBe(1);
    const facts = await listCanonFactsByWork(db, "w1");
    expect(facts).toHaveLength(3);
  });

  it("proposal は message_id+kind で冪等", async () => {
    const db = createTestDb();
    const input = {
      workId: "w1",
      threadId: "t1",
      messageId: "m1",
      kind: "writing_contract",
      payload: { scene_title: "冒頭" },
    };
    const a = await createProposal(db, input);
    const b = await createProposal(db, input);
    expect(b.id).toBe(a.id);
    const got = await getProposalById(db, a.id);
    expect(got!.status).toBe("pending");
  });
});
