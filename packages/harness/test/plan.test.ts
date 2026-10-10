import { describe, expect, it } from "vitest";
import {
  JOB_KIND_PLAN_WORK,
  type AgentJob,
  type ChatMessage,
  type ChatRole,
  type Proposal,
} from "@houchi/contracts";
import { StubProvider } from "@houchi/providers";
import { runJob, type JobContext, type OrchestratorContextData } from "../src/index.js";

const WORK = {
  id: "w1",
  owner_ref: "u1",
  title: "テスト作品",
  premise: "前提",
  genre: "",
  status: "setup" as const,
  charter: null,
  policy: null,
  provider: null,
  model: null,
  key_ref: null,
  canon_rev: 0,
  created_at: 0,
  updated_at: 0,
};
const THREAD = { id: "t1", work_id: "w1", created_at: 0 };

const PAYLOAD = {
  work_id: "w1",
  thread_id: "t1",
  user_ref: "u1",
  key_ref: "key-1",
  provider: "stub",
  model: "stub-model",
};

function makeJob(payload: Record<string, unknown>): AgentJob {
  return {
    id: "j1",
    kind: JOB_KIND_PLAN_WORK,
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

const PLAN_JSON = JSON.stringify({
  episodes: [
    {
      title: "第1話",
      scenes: [
        { title: "廃線ホーム", purpose: "導入" },
        { title: "線路の先", purpose: "決意" },
      ],
    },
  ],
});

function makeCtx(opts: {
  provider: StubProvider;
  store: { payload: Record<string, unknown> };
  persisted: ChatMessage[];
  proposals: Proposal[];
  completed: unknown[];
}) {
  const ctx: JobContext = {
    resolveKey: async () => "key",
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
    complete: async (r) => {
      opts.completed.push(r);
    },
    fail: async () => {},
    fetchOrchestratorContext: async (): Promise<OrchestratorContextData> => ({
      thread: THREAD,
      work: WORK,
      canon_facts: [],
      proposals: [],
      messages: [
        {
          id: "m-user",
          thread_id: "t1",
          role: "user" as ChatRole,
          content: "計画を立てて",
          job_id: null,
          created_at: 0,
        },
      ],
      workspace_files: [
        { path: "/work.json", summary: "作品の基本情報" },
        { path: "/plan/tree.md", summary: "計画ツリー" },
      ],
      plan_tree: "(計画はまだありません)",
    }),
    persistChatMessage: async (req) => {
      const m: ChatMessage = {
        id: `m-${opts.persisted.length + 1}`,
        thread_id: req.thread_id,
        role: req.role,
        content: req.content,
        job_id: req.job_id,
        created_at: opts.persisted.length + 1,
      };
      opts.persisted.push(m);
      return m;
    },
    createProposal: async (req) => {
      const p: Proposal = {
        id: `prop-${opts.proposals.length + 1}`,
        work_id: req.work_id,
        thread_id: req.thread_id,
        message_id: req.message_id,
        kind: req.kind,
        payload: req.payload,
        status: "pending",
        decided_at: null,
        created_at: 0,
      };
      opts.proposals.push(p);
      return p;
    },
  };
  return ctx;
}

describe("plan_work ジョブ", () => {
  it("planner 実行 → kind=plan の提案が作られる", async () => {
    const provider = new StubProvider({ text: PLAN_JSON });
    const persisted: ChatMessage[] = [];
    const proposals: Proposal[] = [];
    const completed: unknown[] = [];
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD } },
      persisted,
      proposals,
      completed,
    });
    expect(await runJob(makeJob({ ...PAYLOAD }), ctx)).toBe("completed");
    expect(provider.calls).toBe(1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe("plan");
    const payload = proposals[0]!.payload as {
      episodes: { title: string; scenes: { title: string }[] }[];
    };
    expect(payload.episodes[0]!.title).toBe("第1話");
    expect(persisted[0]!.role).toBe("assistant");
    const result = completed[0] as {
      kind: string;
      proposal_id: string;
      episode_count: number;
      scene_count: number;
    };
    expect(result.kind).toBe(JOB_KIND_PLAN_WORK);
    expect(result.proposal_id).toBe(proposals[0]!.id);
    expect(result.episode_count).toBe(1);
    expect(result.scene_count).toBe(2);
  });

  it("checkpoint.plan があれば provider を呼ばず提案だけ確定", async () => {
    const provider = new StubProvider({ text: "unused" });
    const proposals: Proposal[] = [];
    const completed: unknown[] = [];
    const checkpoint = {
      plan: JSON.parse(PLAN_JSON) as Record<string, unknown>,
    };
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD, checkpoint } },
      persisted: [],
      proposals,
      completed,
    });
    expect(
      await runJob(makeJob({ ...PAYLOAD, checkpoint }), ctx),
    ).toBe("completed");
    expect(provider.calls).toBe(0);
    expect(proposals).toHaveLength(1);
  });

  it("planner 出力が JSON として壊れているとジョブ失敗", async () => {
    const provider = new StubProvider({ text: "not json" });
    const proposals: Proposal[] = [];
    const completed: unknown[] = [];
    const ctx = makeCtx({
      provider,
      store: { payload: { ...PAYLOAD } },
      persisted: [],
      proposals,
      completed,
    });
    expect(await runJob(makeJob({ ...PAYLOAD }), ctx)).toBe("failed");
    expect(provider.calls).toBe(2); // 1回リトライ
    expect(proposals).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });
});
