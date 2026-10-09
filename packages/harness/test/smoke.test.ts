import { describe, expect, it } from "vitest";
import type { AgentJob, ProgressEventType } from "@houchi/contracts";
import { StubProvider } from "@houchi/providers";
import {
  createDefaultHandlers,
  JobInfraError,
  runJob,
  type JobContext,
} from "../src/index.js";

function makeJob(payload: Record<string, unknown>): AgentJob {
  return {
    id: "j1",
    kind: "smoke_generate",
    work_ref: null,
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

interface Call {
  op: string;
  value?: unknown;
}

function makeCtx(opts: {
  provider: StubProvider;
  /** saveCheckpoint のマージ先 (ジョブ payload を模倣する永続ストア)。 */
  store: { payload: Record<string, unknown> };
  completeFailures?: number;
  resolveKeyReturns?: string;
}) {
  const calls: Call[] = [];
  let completeCalls = 0;
  const ctx: JobContext = {
    resolveKey: async (keyRef) => {
      calls.push({ op: "resolveKey", value: keyRef });
      return opts.resolveKeyReturns ?? "test-key";
    },
    getProvider: (name) => {
      calls.push({ op: "getProvider", value: name });
      return opts.provider;
    },
    postProgress: async (type: ProgressEventType, data) => {
      calls.push({ op: `progress:${type}`, value: data });
    },
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
  };
  return { ctx, calls };
}

const PAYLOAD = {
  model: "stub-model",
  input: [{ role: "user", content: "こんにちは" }],
};

describe("smoke_generate harness", () => {
  it("happy path: resolve→call→persist→complete", async () => {
    const provider = new StubProvider({ text: "hello" });
    const store: { payload: Record<string, unknown> } = { payload: { ...PAYLOAD } };
    const { ctx, calls } = makeCtx({ provider, store });
    const job = makeJob(store.payload);
    const status = await runJob(job, ctx);
    expect(status).toBe("completed");
    expect(provider.calls).toBe(1);
    const ops = calls.map((c) => c.op);
    expect(ops).toEqual([
      "getProvider",
      "progress:status",
      "progress:status",
      "saveCheckpoint",
      "progress:status",
      "complete",
    ]);
    expect(calls.at(-1)!.value).toMatchObject({
      kind: "smoke_generate",
      output_text: "hello",
      resumed_from_checkpoint: false,
    });
    expect(
      (store.payload.checkpoint as Record<string, unknown>).provider_result,
    ).toEqual({ output_text: "hello", usage: "unknown" });
  });

  it("途中kill→再開: 保存済み結果で provider を再呼出しせず完了", async () => {
    const provider = new StubProvider({ text: "hello" });
    const store: { payload: Record<string, unknown> } = { payload: { ...PAYLOAD } };
    // 1回目: checkpoint 保存まで成功し、complete 直前にクラッシュ。
    const first = makeCtx({ provider, store, completeFailures: 1 });
    await expect(
      runJob(makeJob(store.payload), first.ctx),
    ).rejects.toBeInstanceOf(JobInfraError);
    expect(provider.calls).toBe(1);
    expect(store.payload.checkpoint).toBeDefined();

    // 2回目 (再リース): payload.checkpoint が載ったジョブを受け取る。
    const second = makeCtx({ provider, store });
    const status = await runJob(makeJob(store.payload), second.ctx);
    expect(status).toBe("completed");
    // 核心: provider が再呼出しされていない。
    expect(provider.calls).toBe(1);
    expect(second.calls.map((c) => c.op)).toEqual([
      "progress:status",
      "progress:status",
      "complete",
    ]);
    expect(second.calls.at(-1)!.value).toMatchObject({
      output_text: "hello",
      resumed_from_checkpoint: true,
    });
  });

  it("checkpoint 済みなら初回実行でも provider を呼ばない", async () => {
    const provider = new StubProvider({ text: "x" });
    const store: { payload: Record<string, unknown> } = {
      payload: {
        ...PAYLOAD,
        checkpoint: { provider_result: { output_text: "y", usage: "unknown" } },
      },
    };
    const { ctx } = makeCtx({ provider, store });
    await runJob(makeJob(store.payload), ctx);
    expect(provider.calls).toBe(0);
  });

  it("provider 障害はジョブ失敗 (fail 呼ばれる)", async () => {
    const provider = new StubProvider({ failWith: new Error("provider boom") });
    const store: { payload: Record<string, unknown> } = { payload: { ...PAYLOAD } };
    const { ctx, calls } = makeCtx({ provider, store });
    const status = await runJob(makeJob(store.payload), ctx);
    expect(status).toBe("failed");
    expect(calls.at(-1)).toMatchObject({ op: "fail" });
  });

  it("payload 不正はジョブ失敗", async () => {
    const provider = new StubProvider();
    const store = { payload: { model: "" } };
    const { ctx, calls } = makeCtx({ provider, store });
    const status = await runJob(makeJob(store.payload), ctx);
    expect(status).toBe("failed");
    expect(provider.calls).toBe(0);
  });

  it("未知 kind は fail", async () => {
    const provider = new StubProvider();
    const store = { payload: {} };
    const { ctx, calls } = makeCtx({ provider, store });
    const job = { ...makeJob(store.payload), kind: "mystery" };
    const status = await runJob(job, ctx, createDefaultHandlers());
    expect(status).toBe("failed");
    expect(calls.at(-1)!.op).toBe("fail");
  });

  it("stream: token 進捗が順序通り流れる", async () => {
    const provider = new StubProvider({ text: "abcd", chunkSize: 2 });
    const store = { payload: { ...PAYLOAD, stream: true } };
    const { ctx, calls } = makeCtx({ provider, store });
    await runJob(makeJob(store.payload), ctx);
    const tokenEvents = calls
      .filter((c) => c.op === "progress:token")
      .map((c) => (c.value as { text: string }).text);
    expect(tokenEvents).toEqual(["ab", "cd"]);
  });
});
