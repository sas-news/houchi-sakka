import { describe, expect, it } from "vitest";
import {
  JOB_KIND_GENERATE_SCENE,
  type AgentJob,
  type CanonFact,
  type DependencyEdgeInput,
  type ProviderRequest,
  type Scene,
  type SceneRevision,
  type Work,
  type WritingContract,
} from "@houchi/contracts";
import { StubProvider } from "@houchi/providers";
import { runJob, type JobContext } from "../src/index.js";
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

/** writer/critic のスキルプロンプトを識別して JSON を返すスタブ応答。 */
function respond(opts: { critic: string }): (req: ProviderRequest) => string {
  return (req) => {
    const joined = req.input.map((m) => m.content).join("\n");
    if (joined.includes("執筆担当")) {
      const revised = joined.includes("この指摘を直して書き直してください");
      return JSON.stringify({
        prose_md: revised ? "改稿した本文。" : "ドラフト本文。",
        canon_facts_new: ["新しい正典"],
        depends_on: [
          { target_kind: "canon_fact", target_ref: "汽車はもう走っていない" },
        ],
      });
    }
    if (joined.includes("検査担当")) return opts.critic;
    return "{}";
  };
}

function makeCtx(opts: {
  provider: StubProvider;
  store: { payload: Record<string, unknown> };
  sceneCtx: SceneContextData;
  revisions: SceneRevision[];
  completed: unknown[];
  canonFacts?: { statements: string[]; provenance: string }[];
  deps?: { sceneId: string; edges: DependencyEdgeInput[] }[];
}) {
  const ctx: JobContext = {
    resolveKey: async () => "resolved-key",
    getProvider: () => opts.provider,
    postProgress: async () => {},
    saveCheckpoint: async (patch) => {
      opts.store.payload = {
        ...opts.store.payload,
        checkpoint: {
          ...(opts.store.payload.checkpoint as
            | Record<string, unknown>
            | undefined),
          ...patch,
        },
      };
    },
    complete: async (result) => {
      opts.completed.push(result);
    },
    fail: async () => {},
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
    addCanonFacts: async (req) => {
      (opts.canonFacts ??= []).push(req);
      return { added: req.statements.length };
    },
    recordDependencies: async (req) => {
      (opts.deps ??= []).push({
        sceneId: req.scene_id,
        edges: req.edges,
      });
      return { added: req.edges.length };
    },
  };
  return ctx;
}

function sceneCtx(contract: WritingContract | null): SceneContextData {
  const canon: CanonFact[] = [
    {
      id: "f1",
      work_id: "w1",
      statement: "汽車はもう走っていない",
      provenance: "orchestrator",
      created_at: 0,
    },
  ];
  return {
    scene: SCENE,
    contract,
    work: WORK,
    canon_facts: canon,
    prev_scenes: [],
  };
}

const CLEAN_CRITIC = JSON.stringify({ violations: [], notes: ["ok"] });
const HIGH_CRITIC = JSON.stringify({
  violations: [
    { rule: "required_events", detail: "必須イベントが抜けている", severity: "high" },
  ],
  notes: [],
});

describe("generate_scene 多段パイプライン", () => {
  it("契約が未承認なら失敗する (ゲート)", async () => {
    const provider = new StubProvider({ respond: respond({ critic: CLEAN_CRITIC }) });
    const completed: unknown[] = [];
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD } },
      sceneCtx: sceneCtx({ ...CONTRACT, status: "draft" }),
      revisions: [],
      completed,
    });
    expect(await runJob(makeJob({ ...PAYLOAD }), ctx)).toBe("failed");
    expect(provider.calls).toBe(0);
  });

  it("write→critique(違反なし)→revise なし→確定。依存と正典を記録", async () => {
    const provider = new StubProvider({ respond: respond({ critic: CLEAN_CRITIC }) });
    const revisions: SceneRevision[] = [];
    const completed: unknown[] = [];
    const canonFacts: { statements: string[]; provenance: string }[] = [];
    const deps: { sceneId: string; edges: DependencyEdgeInput[] }[] = [];
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD } },
      sceneCtx: sceneCtx(CONTRACT),
      revisions,
      completed,
      canonFacts,
      deps,
    });
    expect(await runJob(makeJob({ ...PAYLOAD }), ctx)).toBe("completed");
    // writer 1回 + critic 1回 (revise は走らない)
    expect(provider.calls).toBe(2);
    expect(revisions).toHaveLength(1);
    const doc = revisions[0]!.content_json as {
      content: { content: { text: string }[] }[];
    };
    expect(doc.content[0]!.content[0]!.text).toBe("ドラフト本文。");
    expect(canonFacts).toHaveLength(1);
    expect(canonFacts[0]!.statements).toContain("新しい正典");
    expect(deps).toHaveLength(1);
    expect(deps[0]!.edges[0]!.target_kind).toBe("canon_fact");
    const result = completed[0] as {
      revised: boolean;
      critique_summary: { high: number; notes: number };
    };
    expect(result.revised).toBe(false);
    expect(result.critique_summary.notes).toBe(1);
  });

  it("critic が high 指摘 → revise を実行し改稿文を保存", async () => {
    const provider = new StubProvider({ respond: respond({ critic: HIGH_CRITIC }) });
    const revisions: SceneRevision[] = [];
    const completed: unknown[] = [];
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD } },
      sceneCtx: sceneCtx(CONTRACT),
      revisions,
      completed,
    });
    expect(await runJob(makeJob({ ...PAYLOAD }), ctx)).toBe("completed");
    // write + critique + revise = 3回
    expect(provider.calls).toBe(3);
    const doc = revisions[0]!.content_json as {
      content: { content: { text: string }[] }[];
    };
    expect(doc.content[0]!.content[0]!.text).toBe("改稿した本文。");
    const result = completed[0] as {
      revised: boolean;
      critique_summary: { high: number };
    };
    expect(result.revised).toBe(true);
    expect(result.critique_summary.high).toBe(1);
  });

  it("writer 済みで落ちた→resume は writer を再実行しない", async () => {
    const provider = new StubProvider({ respond: respond({ critic: CLEAN_CRITIC }) });
    const revisions: SceneRevision[] = [];
    const completed: unknown[] = [];
    const checkpoint = {
      draft: {
        prose_md: "保存済みドラフト。",
        canon_facts_new: [],
        depends_on: [],
      },
    };
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD, checkpoint } },
      sceneCtx: sceneCtx(CONTRACT),
      revisions,
      completed,
    });
    expect(await runJob(makeJob({ ...PAYLOAD, checkpoint }), ctx)).toBe("completed");
    // critic のみ呼ばれる (write は checkpoint から復元)
    expect(provider.calls).toBe(1);
    const doc = revisions[0]!.content_json as {
      content: { content: { text: string }[] }[];
    };
    expect(doc.content[0]!.content[0]!.text).toBe("保存済みドラフト。");
  });

  it("draft+critique+final が揃っていれば provider を呼ばず確定だけ行う", async () => {
    const provider = new StubProvider({ respond: respond({ critic: CLEAN_CRITIC }) });
    const revisions: SceneRevision[] = [];
    const completed: unknown[] = [];
    const checkpoint = {
      draft: { prose_md: "d", canon_facts_new: [], depends_on: [] },
      critique: { violations: [], notes: [] },
      final: { prose_md: "最終稿", canon_facts_new: [], depends_on: [] },
    };
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD, checkpoint } },
      sceneCtx: sceneCtx(CONTRACT),
      revisions,
      completed,
    });
    expect(await runJob(makeJob({ ...PAYLOAD, checkpoint }), ctx)).toBe("completed");
    expect(provider.calls).toBe(0);
    const doc = revisions[0]!.content_json as {
      content: { content: { text: string }[] }[];
    };
    expect(doc.content[0]!.content[0]!.text).toBe("最終稿");
    const result = completed[0] as { resumed_from_checkpoint: boolean };
    expect(result.resumed_from_checkpoint).toBe(true);
  });
});
