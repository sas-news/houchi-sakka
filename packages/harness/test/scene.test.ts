import { describe, expect, it } from "vitest";
import {
  JOB_KIND_GENERATE_SCENE,
  type AgentJob,
  type ChatThread,
  type Scene,
  type SceneRevision,
  type Work,
  type WritingContract,
} from "@houchi/contracts";
import { StubProvider } from "@houchi/providers";
import { runJob, JobInfraError, type JobContext } from "../src/index.js";
import type { SceneContextData } from "../src/scene.js";

const WORK: Work = {
  id: "w1",
  owner_ref: "u1",
  title: "テスト作品",
  premise: "前提",
  genre: "ファンタジー",
  status: "active",
  charter: null,
  policy: null,
  provider: null,
  model: null,
  key_ref: null,
  created_at: 0,
  updated_at: 0,
};
const SCENE: Scene = {
  id: "s1",
  episode_id: "e1",
  ord: 1,
  title: "廃線ホーム",
  purpose: "導入",
  status: "approved",
  created_at: 0,
  updated_at: 0,
};
const CONTRACT: WritingContract = {
  id: "c1",
  scene_id: "s1",
  status: "approved",
  payload: {
    role: "導入",
    pov: "三人称",
    required_events: ["雨上がり"],
    forbidden: [],
    knowledge_notes: "",
    connections: "",
  },
  created_at: 0,
  decided_at: 1,
};

function makeJob(payload: Record<string, unknown>): AgentJob {
  return {
    id: "j1",
    kind: JOB_KIND_GENERATE_SCENE,
    work_ref: "w1",
    user_ref: "u1",
    payload,
    idempotency_key: "k",
    status: "leased",
    leased_by: "ex",
    lease_token: "t",
    lease_expires_at: Date.now() + 60_000,
    attempts: 1,
    result: null,
    error: null,
    created_at: 0,
    updated_at: 0,
  };
}

const PAYLOAD = {
  scene_id: "s1",
  contract_id: "c1",
  work_id: "w1",
  user_ref: "u1",
  key_ref: "key-1",
  provider: "stub",
  model: "stub-model",
};

function makeCtx(opts: {
  provider: StubProvider;
  store: { payload: Record<string, unknown> };
  sceneCtx: SceneContextData;
  revisions: SceneRevision[];
  completed: unknown[];
}) {
  const calls: { op: string; value?: unknown }[] = [];
  const ctx: JobContext = {
    resolveKey: async () => "resolved-key",
    getProvider: () => opts.provider,
    postProgress: async (type, data) => {
      calls.push({ op: "progress", value: { type, data } });
    },
    saveCheckpoint: async (patch) => {
      opts.store.payload = {
        ...opts.store.payload,
        checkpoint: {
          ...(opts.store.payload.checkpoint as Record<string, unknown> | undefined),
          ...patch,
        },
      };
      calls.push({ op: "checkpoint", value: patch });
    },
    complete: async (result) => {
      opts.completed.push(result);
      calls.push({ op: "complete", value: result });
    },
    fail: async (error) => {
      calls.push({ op: "fail", value: error });
    },
    fetchSceneContext: async () => opts.sceneCtx,
    persistSceneRevision: async (req) => {
      const rev: SceneRevision = {
        id: `rev-${opts.revisions.length + 1}`,
        scene_id: req.scene_id,
        rev_no: opts.revisions.length + 1,
        content_json: req.content_json,
        source: req.source,
        job_id: req.job_id,
        created_at: opts.revisions.length + 1,
      };
      opts.revisions.push(rev);
      return rev;
    },
  };
  return { ctx, calls };
}

function sceneCtx(contract: WritingContract | null): SceneContextData {
  return {
    scene: SCENE,
    contract,
    work: WORK,
    canon_facts: [
      {
        id: "f1",
        work_id: "w1",
        statement: "汽車はもう走っていない",
        provenance: "orchestrator",
        created_at: 0,
      },
    ],
    prev_scenes: [],
  };
}

describe("generate_scene harness", () => {
  it("契約が未承認なら失敗する (ゲート)", async () => {
    const provider = new StubProvider({ text: "本文" });
    const store = { payload: { ...PAYLOAD } };
    const revisions: SceneRevision[] = [];
    const completed: unknown[] = [];
    const { ctx } = makeCtx({
      provider,
      store,
      sceneCtx: sceneCtx({ ...CONTRACT, status: "draft" }),
      revisions,
      completed,
    });
    expect(await runJob(makeJob(store.payload), ctx)).toBe("failed");
    expect(provider.calls).toBe(0);
    expect(revisions).toHaveLength(0);
  });

  it("contract_id が payload と違う契約なら失敗する", async () => {
    const provider = new StubProvider({ text: "本文" });
    const store = { payload: { ...PAYLOAD } };
    const { ctx } = makeCtx({
      provider,
      store,
      sceneCtx: sceneCtx({ ...CONTRACT, id: "c-other" }),
      revisions: [],
      completed: [],
    });
    expect(await runJob(makeJob(store.payload), ctx)).toBe("failed");
    expect(provider.calls).toBe(0);
  });

  it("承認済み契約で生成 → Tiptap doc でリビジョン保存 → complete", async () => {
    const provider = new StubProvider({
      text: "段落一。\n\n段落二。",
    });
    const store = { payload: { ...PAYLOAD } };
    const revisions: SceneRevision[] = [];
    const completed: unknown[] = [];
    const { ctx } = makeCtx({
      provider,
      store,
      sceneCtx: sceneCtx(CONTRACT),
      revisions,
      completed,
    });
    expect(await runJob(makeJob(store.payload), ctx)).toBe("completed");
    expect(provider.calls).toBe(1);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.rev_no).toBe(1);
    expect(revisions[0]!.source).toBe("ai");
    expect(revisions[0]!.job_id).toBe("j1");
    const doc = revisions[0]!.content_json as {
      type: string;
      content: { content: { text: string }[] }[];
    };
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(2);
    const result = completed[0] as { kind: string; revision_id: string };
    expect(result.kind).toBe(JOB_KIND_GENERATE_SCENE);
    expect(result.revision_id).toBe(revisions[0]!.id);
  });

  it("provider_result checkpoint から再開したらプロバイダーを呼ばない", async () => {
    const provider = new StubProvider({ text: "unused" });
    const store = {
      payload: {
        ...PAYLOAD,
        checkpoint: {
          provider_result: {
            output_text: "再開した本文。",
            usage: "unknown" as const,
          },
        },
      },
    };
    const revisions: SceneRevision[] = [];
    const completed: unknown[] = [];
    const { ctx } = makeCtx({
      provider,
      store,
      sceneCtx: sceneCtx(CONTRACT),
      revisions,
      completed,
    });
    expect(await runJob(makeJob(store.payload), ctx)).toBe("completed");
    expect(provider.calls).toBe(0);
    expect(revisions).toHaveLength(1);
    const result = completed[0] as { resumed_from_checkpoint: boolean };
    expect(result.resumed_from_checkpoint).toBe(true);
  });
});
