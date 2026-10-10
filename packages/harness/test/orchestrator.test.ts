import { describe, expect, it } from "vitest";
import type {
  AgentJob,
  ChatMessage,
  ChatRole,
  ProgressEventType,
} from "@houchi/contracts";
import { StubProvider } from "@houchi/providers";
import {
  createDefaultHandlers,
  JobInfraError,
  runJob,
  type JobContext,
  type OrchestratorContextData,
} from "../src/index.js";

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
  created_at: 0,
  updated_at: 0,
};
const THREAD = { id: "t1", work_id: "w1", created_at: 0 };

function makeJob(payload: Record<string, unknown>): AgentJob {
  return {
    id: "j1",
    kind: "orchestrator_turn",
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
  thread_id: "t1",
  work_id: "w1",
  user_ref: "u1",
  key_ref: "key-1",
  provider: "openai",
  model: "stub-model",
  trigger_message_id: "m-user",
};

interface Call {
  op: string;
  value?: unknown;
}

function makeCtx(opts: {
  provider: StubProvider;
  store: { payload: Record<string, unknown> };
  persisted: ChatMessage[];
  patches: { workId: string; patch: Record<string, unknown> }[];
  proposals?: { payload: Record<string, unknown> }[];
  canonFacts?: { statements: string[]; provenance: string }[];
  completeFailures?: number;
}) {
  const calls: Call[] = [];
  let completeCalls = 0;
  let msgSeq = 0;
  const ctx: JobContext = {
    resolveKey: async (keyRef, jobId) => {
      calls.push({ op: "resolveKey", value: `${keyRef}@${jobId}` });
      return "resolved-key";
    },
    getProvider: () => opts.provider,
    postProgress: async (_t: ProgressEventType, _d: unknown) => {},
    saveCheckpoint: async (patch) => {
      const prev =
        (opts.store.payload.checkpoint as Record<string, unknown>) ?? {};
      opts.store.payload = {
        ...opts.store.payload,
        checkpoint: { ...prev, ...patch },
      };
      calls.push({ op: "saveCheckpoint", value: patch });
    },
    complete: async (result) => {
      completeCalls += 1;
      if (completeCalls <= (opts.completeFailures ?? 0)) {
        throw new JobInfraError("simulated crash after checkpoint persist");
      }
      calls.push({ op: "complete", value: result });
    },
    fail: async (error) => {
      calls.push({ op: "fail", value: error });
    },
    fetchOrchestratorContext: async (
      threadId: string,
    ): Promise<OrchestratorContextData> => ({
      thread: THREAD,
      work: WORK,
      canon_facts: [],
      proposals: [],
      messages: [
        {
          id: "m-user",
          thread_id: "t1",
          role: "user" as ChatRole,
          content: "ファンタジーにしたい",
          job_id: null,
          created_at: 0,
        },
      ],
      workspace_files: [
        { path: "/work.json", summary: "作品の基本情報" },
        { path: "/canon/facts.md", summary: "正典メモ 0件" },
      ],
      plan_tree: "(計画はまだありません)",
    }),
    persistChatMessage: async (req) => {
      const m: ChatMessage = {
        id: `m-${++msgSeq}`,
        thread_id: req.thread_id,
        role: req.role,
        content: req.content,
        job_id: req.job_id ?? null,
        created_at: msgSeq,
      };
      opts.persisted.push(m);
      return m;
    },
    applyWorkPatch: async (workId, patch) => {
      opts.patches.push({ workId, patch });
    },
    createProposal: async (req) => {
      const proposal = {
        id: `prop-${++msgSeq}`,
        work_id: req.work_id,
        thread_id: req.thread_id,
        message_id: req.message_id,
        kind: req.kind,
        payload: req.payload,
        status: "pending" as const,
        decided_at: null,
        created_at: msgSeq,
      };
      (opts.proposals ??= []).push(proposal);
      return proposal;
    },
    addCanonFacts: async (req) => {
      (opts.canonFacts ??= []).push(req);
      return { added: req.statements.length };
    },
  };
  return { ctx, calls };
}

describe("orchestrator_turn harness", () => {
  it("happy path: 生成 → assistant メッセージ永続化 → complete", async () => {
    const provider = new StubProvider({ text: "わかりました" });
    const store: { payload: Record<string, unknown> } = {
      payload: { ...PAYLOAD },
    };
    const persisted: ChatMessage[] = [];
    const patches: { workId: string; patch: Record<string, unknown> }[] = [];
    const { ctx, calls } = makeCtx({ provider, store, persisted, patches });

    const status = await runJob(makeJob(store.payload), ctx);
    expect(status).toBe("completed");
    expect(provider.calls).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.role).toBe("assistant");
    expect(persisted[0]!.content).toBe("わかりました");
    expect(persisted[0]!.job_id).toBe("j1");
    const result = calls.at(-1)!.value as Record<string, unknown>;
    expect(result.kind).toBe("orchestrator_turn");
    expect(result.message_id).toBe("m-1");
    expect(
      (store.payload.checkpoint as Record<string, unknown>).provider_result,
    ).toBeDefined();
  });

  it("WORK_PATCH 行は works に適用され本文には残さない", async () => {
    const provider = new StubProvider({
      text: '案内です\n<<WORK_PATCH {"genre":"SF","title":"新作"}>>',
    });
    const store = { payload: { ...PAYLOAD } };
    const persisted: ChatMessage[] = [];
    const patches: { workId: string; patch: Record<string, unknown> }[] = [];
    const { ctx } = makeCtx({ provider, store, persisted, patches });
    await runJob(makeJob(store.payload), ctx);
    expect(persisted[0]!.content).toBe("案内です");
    expect(patches).toEqual([
      { workId: "w1", patch: { genre: "SF", title: "新作" } },
    ]);
  });

  it("途中kill→再開: provider 再呼出しせずメッセージだけ確定", async () => {
    const provider = new StubProvider({ text: "hello" });
    const store = { payload: { ...PAYLOAD } };
    const persisted: ChatMessage[] = [];
    const patches: { workId: string; patch: Record<string, unknown> }[] = [];

    // 1回目: complete でクラッシュ (checkpoint は永続化済み)
    const first = makeCtx({
      provider,
      store,
      persisted,
      patches,
      completeFailures: 1,
    });
    await expect(
      runJob(makeJob(store.payload), first.ctx),
    ).rejects.toBeInstanceOf(JobInfraError);
    expect(provider.calls).toBe(1);
    expect(persisted).toHaveLength(1);

    // 2回目: checkpoint から再開 → provider 再呼出しなし。
    // assistant_message_id が checkpoint にあるのでメッセージも再生成しない
    // (実運用では job_id ユニーク制約で冪等)。
    const second = makeCtx({ provider, store, persisted, patches });
    const status = await runJob(makeJob(store.payload), second.ctx);
    expect(status).toBe("completed");
    expect(provider.calls).toBe(1);
    expect(persisted).toHaveLength(1);
  });

  it("<<RUN_PLAN>> で plan_work ジョブを起票する", async () => {
    const provider = new StubProvider({
      text: "計画を立てます\n<<RUN_PLAN {\"guidance\": \"序盤だけ\"}>>",
    });
    const store = { payload: { ...PAYLOAD } };
    const persisted: ChatMessage[] = [];
    const patches: { workId: string; patch: Record<string, unknown> }[] = [];
    const enqueued: { kind: string; payload: Record<string, unknown> }[] = [];
    const { ctx } = makeCtx({ provider, store, persisted, patches });
    ctx.enqueueJob = async (req) => {
      enqueued.push({ kind: req.kind, payload: req.payload });
      return {
        id: "job-plan",
        kind: req.kind,
        work_ref: req.work_ref,
        user_ref: req.user_ref,
        payload: req.payload,
        idempotency_key: req.idempotency_key,
        status: "queued" as const,
        leased_by: null,
        lease_token: null,
        lease_expires_at: null,
        attempts: 0,
        result: null,
        error: null,
        created_at: 0,
        updated_at: 0,
      };
    };
    await runJob(makeJob(store.payload), ctx);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe("plan_work");
    expect(enqueued[0]!.payload.guidance).toBe("序盤だけ");
    expect(enqueued[0]!.payload.thread_id).toBe("t1");
    expect(enqueued[0]!.payload.key_ref).toBe("key-1");
  });

  it("context 未取得 (web 未対応) は fail する", async () => {
    const provider = new StubProvider({ text: "x" });
    const store = { payload: { ...PAYLOAD } };
    const { ctx, calls } = makeCtx({
      provider,
      store,
      persisted: [],
      patches: [],
    });
    delete ctx.fetchOrchestratorContext;
    const status = await runJob(makeJob(store.payload), ctx);
    expect(status).toBe("failed");
    expect(provider.calls).toBe(0);
  });
});
