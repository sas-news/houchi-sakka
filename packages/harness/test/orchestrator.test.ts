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
