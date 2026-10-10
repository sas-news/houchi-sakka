import { JobInfraError, runJob, type JobContext } from "@houchi/harness";
import type { Provider } from "@houchi/providers";
import type { ApiClient } from "./api.js";

/**
 * apps/runner — 薄い実行ループ。
 * 状態遷移・チェックポイント判定は packages/harness に委譲し、
 * ここはリース取得 → JobContext 組立 → 実行の配管だけを担う。
 *
 * 配管 (progress/heartbeat/complete/fail) の失敗は JobInfraError に包む:
 * 基盤障害でジョブを failed にすると再開できなくなるため、leased のまま残し
 * リース期限切れ → 再リースの回復経路に任せる (spec §7.5)。
 */

export interface RunnerDeps {
  api: ApiClient;
  executorId: string;
  leaseTtlMs: number;
  providers: Record<string, Provider>;
  /** --env-key モード: DB ではなく環境変数のキーを使う。 */
  envKey?: string;
  /** token 進捗のバッファ flush 間隔 (ミリ秒)。 */
  tokenFlushMs?: number;
  log?: (msg: string) => void;
}

const TOKEN_FLUSH_MS = 500;

function infra<T extends unknown[], R>(
  op: string,
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof JobInfraError) throw e;
      throw new JobInfraError(`${op} failed: ${String(e)}`, e);
    }
  };
}

/**
 * 1 回のポーリング。ジョブを取れなければ false、処理したら true。
 * JobInfraError が出た場合もジョブは leased のまま残るので true を返す。
 */
export async function tick(deps: RunnerDeps): Promise<boolean> {
  const { api, log } = deps;
  const lease = await api.lease({
    executor_id: deps.executorId,
    lease_ttl_ms: deps.leaseTtlMs,
  });
  const job = lease.job;
  if (!job || !lease.lease_token) return false;

  const jobId = job.id;
  const leaseToken = lease.lease_token;
  log?.(`leased job ${jobId} kind=${job.kind} attempt=${job.attempts}`);

  const postProgress = infra("progress", (type: "status" | "token" | "note", data: unknown) =>
    api.progress(jobId, { lease_token: leaseToken, type, data }).then(() => {}),
  );

  // token 進捗は大量の POST にならないようバッファして流す。
  let tokenBuf = "";
  let lastFlush = Date.now();
  const flushMs = deps.tokenFlushMs ?? TOKEN_FLUSH_MS;
  const flushTokens = async () => {
    if (tokenBuf === "") return;
    const text = tokenBuf;
    tokenBuf = "";
    lastFlush = Date.now();
    await postProgress("token", { text });
  };

  const ctx: JobContext = {
    resolveKey: async (keyRef, jobRef) => {
      if (deps.envKey !== undefined) return deps.envKey;
      if (!keyRef) {
        throw new Error(
          "job payload has no key_ref (use --env-key for local runs)",
        );
      }
      const res = await api.resolveKey(keyRef, { job_id: jobRef ?? jobId });
      return res.api_key;
    },
    fetchOrchestratorContext: async (threadId) =>
      api.getThreadContext(threadId),
    persistChatMessage: async (req) => {
      const res = await api.appendMessage(req.thread_id, req);
      return res.message;
    },
    applyWorkPatch: async (workId, patch) => {
      await api.patchWork(workId, patch);
    },
    createProposal: async (req) => {
      const res = await api.createProposal(req);
      return res.proposal;
    },
    addCanonFacts: async (req) => {
      const res = await api.addCanonFacts(req.work_id, {
        statements: req.statements,
        provenance: req.provenance,
      });
      return { added: res.added };
    },
    recordDependencies: async (req) => {
      const res = await api.recordSceneDependencies(req.scene_id, {
        edges: req.edges,
      });
      return { added: res.added };
    },
    enqueueJob: async (req) => {
      const res = await api.createJob({
        kind: req.kind,
        work_ref: req.work_ref,
        user_ref: req.user_ref,
        payload: req.payload,
        idempotency_key: req.idempotency_key,
      });
      return res.job;
    },
    fetchSceneContext: async (sceneId) => api.getSceneContext(sceneId),
    persistSceneRevision: async (req) => {
      const res = await api.persistSceneRevision(req.scene_id, {
        content_json: req.content_json,
        source: req.source,
        job_id: req.job_id,
      });
      return res.revision;
    },
    getProvider: (name) => {
      const provider = deps.providers[name ?? "openai"];
      if (!provider) throw new Error(`unknown provider: ${name}`);
      return provider;
    },
    postProgress: async (type, data) => {
      if (type === "token") {
        tokenBuf += (data as { text?: string }).text ?? "";
        if (Date.now() - lastFlush < flushMs) return;
        await flushTokens();
        return;
      }
      await flushTokens();
      await postProgress(type, data);
    },
    saveCheckpoint: infra("checkpoint", async (patch) => {
      await api.heartbeat(jobId, {
        lease_token: leaseToken,
        lease_ttl_ms: deps.leaseTtlMs,
        checkpoint: patch,
      });
    }),
    complete: infra("complete", async (result) => {
      await flushTokens();
      await api.complete(jobId, { lease_token: leaseToken, result });
    }),
    fail: infra("fail", async (error) => {
      await api.fail(jobId, { lease_token: leaseToken, error });
    }),
  };

  try {
    const status = await runJob(job, ctx);
    log?.(`job ${jobId} ${status}`);
  } catch (e) {
    if (e instanceof JobInfraError) {
      log?.(`job ${jobId}: infra error (${e.message}) — left leased for retry`);
    } else {
      throw e;
    }
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 常駐ポーリングループ。signal で停止できる。 */
export async function runLoop(
  deps: RunnerDeps,
  pollMs: number,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    let worked = false;
    try {
      worked = await tick(deps);
    } catch (e) {
      // リース取得自体の失敗 (web 側障害) はログって再試行。
      deps.log?.(`tick error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!worked) await sleep(pollMs);
  }
}
