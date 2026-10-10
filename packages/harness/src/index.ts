import {
  JOB_KIND_GENERATE_SCENE,
  JOB_KIND_ORCHESTRATOR_TURN,
  JOB_KIND_PLAN_WORK,
  JOB_KIND_SMOKE_GENERATE,
  SmokeGeneratePayloadSchema,
  type AgentJob,
  type CanonFact,
  type ChatMessage,
  type ChatRole,
  type ChatThread,
  type DependencyEdgeInput,
  type ProgressEventType,
  type Proposal,
  type SceneRevision,
  type SmokeGenerateResult,
  type Work,
  type WorkPatchRequest,
  type WorkspaceFile,
} from "@houchi/contracts";
import type { Provider, TokenCallback } from "@houchi/providers";
import { runOrchestratorTurn } from "./orchestrator.js";
import { runPlanWork } from "./plan.js";
import { runGenerateScene, type SceneContextData } from "./scene.js";

/**
 * packages/harness — ジョブ種別ごとの永続ステートマシン (spec §8.1 Harness)。
 * runner は薄い実行ループで、状態遷移とチェックポイント判定はここに置く。
 *
 * エラー分類 (runner が失敗処理を分岐するための契約):
 * - JobInfraError: API 疎通などの基盤障害。ジョブは failed にせず
 *   リース期限切れ→再リースで再開させる。
 * - それ以外の例外: ジョブ起因 (payload 不正・プロバイダー障害など)。
 *   runJob が ctx.fail で failed マークする。
 */

/** ctx の配管 (progress/checkpoint/complete/fail) での失敗を包む印。 */
export class JobInfraError extends Error {
  override name = "JobInfraError";
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** orchestrator_turn がスレッド履歴と作品情報を取る経路の返り値。 */
export interface OrchestratorContextData {
  work: Work;
  thread: ChatThread;
  messages: ChatMessage[];
  /** 記録済みの正典メモ (再提案の抑止と契約材料に使う)。 */
  canon_facts: CanonFact[];
  /** 作品の提案一覧 (pending 判定はこちら側で行う)。 */
  proposals: Proposal[];
  /** workspace のファイル一覧 (一覧+要約のみ。Phase 2a)。 */
  workspace_files: WorkspaceFile[];
  /** /plan/tree.md の内容 (planner の入力にも使う)。 */
  plan_tree: string;
}

/**
 * 実行時に runner が差し込むポート群。
 * resolveKey / getProvider はジョブ起因の失敗をそのまま投げてよい。
 * postProgress / saveCheckpoint / complete / fail は失敗時 JobInfraError を投げる
 * こと (runner 側で包む実装にする)。
 * fetchOrchestratorContext / persistChatMessage / applyWorkPatch は
 * orchestrator_turn 専用で、ジョブ起因の失敗をそのまま投げてよい。
 */
export interface JobContext {
  /**
   * key_ref を平文キーへ解決する。jobId はサーバー側の owner 照合
   * (ジョブを起こしたユーザーとキー所有者の一致確認) に使われる。
   */
  resolveKey(
    keyRef: string | undefined,
    jobId?: string,
  ): Promise<string | undefined>;
  getProvider(name: string | undefined): Provider;
  postProgress(type: ProgressEventType, data: unknown): Promise<void>;
  /** payload.checkpoint への永続マージ。 */
  saveCheckpoint(patch: Record<string, unknown>): Promise<void>;
  /** 成果物確定 + 完了マーク (アトミック)。 */
  complete(result: unknown): Promise<void>;
  fail(error: string): Promise<void>;
  /** orchestrator_turn: スレッド履歴と作品情報を取得する。 */
  fetchOrchestratorContext?(
    threadId: string,
  ): Promise<OrchestratorContextData>;
  /** orchestrator_turn: assistant メッセージを永続化する (job_id で冪等)。 */
  persistChatMessage?(input: {
    thread_id: string;
    role: ChatRole;
    content: string;
    job_id: string;
  }): Promise<ChatMessage>;
  /** orchestrator_turn: WORK_PATCH を作品へ適用する。 */
  applyWorkPatch?(workId: string, patch: WorkPatchRequest): Promise<void>;
  /** orchestrator_turn: 提案を作成する (episode/scene/contract を含め作成)。 */
  createProposal?(input: {
    work_id: string;
    thread_id: string;
    message_id: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<Proposal>;
  /** orchestrator_turn: 正典メモを追加する (statement 重複はスキップ)。 */
  addCanonFacts?(input: {
    work_id: string;
    statements: string[];
    provenance: string;
  }): Promise<{ added: number }>;
  /** generate_scene: シーン+契約+作品+正典+直近シーンを取得する。 */
  fetchSceneContext?(sceneId: string): Promise<SceneContextData>;
  /** generate_scene: リビジョンを保存しシーンを generated にする。 */
  persistSceneRevision?(input: {
    scene_id: string;
    content_json: unknown;
    source: "ai" | "manual_edit";
    job_id: string | null;
  }): Promise<SceneRevision>;
  /** generate_scene: writer の依存宣言を dependency_edges に記録する。 */
  recordDependencies?(input: {
    scene_id: string;
    work_id: string;
    edges: DependencyEdgeInput[];
  }): Promise<{ added: number }>;
  /**
   * オーケストレーターのマーカーから別ジョブを起票する
   * (<<RUN_PLAN>> → plan_work など)。idempotency_key で冪等。
   */
  enqueueJob?(input: {
    kind: string;
    work_ref: string;
    user_ref: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<AgentJob>;
}

export type JobHandler = (job: AgentJob, ctx: JobContext) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

// ---------------------------------------------------------------------------
// smoke_generate: (a) resolve key → (b) call provider → (c) persist result
// → (d) mark complete。provider 応答はチェックポイント化してから完了に進むので、
// 途中死亡→再リース時は呼び出しをスキップして完了だけ行う (spec §7.5/Phase 0)。
// ---------------------------------------------------------------------------

export const runSmokeGenerate: JobHandler = async (job, ctx) => {
  const payload = SmokeGeneratePayloadSchema.parse(job.payload);
  const checkpoint = payload.checkpoint ?? {};
  const resumed = checkpoint.provider_result !== undefined;
  let providerResult = checkpoint.provider_result;

  if (providerResult === undefined) {
    const provider = ctx.getProvider(payload.provider);
    const apiKey = provider.requiresKey
      ? await ctx.resolveKey(payload.key_ref, job.id)
      : undefined;

    // token 進捗は発行順を保つよう逐次化する。
    let progressChain: Promise<void> = Promise.resolve();
    const onToken: TokenCallback | undefined = payload.stream
      ? (text) => {
          progressChain = progressChain.then(() =>
            ctx.postProgress("token", { text }),
          );
        }
      : undefined;

    await ctx.postProgress("status", {
      step: "call_provider",
      model: payload.model,
      stream: payload.stream === true,
    });
    providerResult = await provider.generate(
      {
        model: payload.model,
        input: payload.input,
        ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
      },
      apiKey ?? "",
      onToken,
    );
    await progressChain;

    // 完了マークより先に結果を永続化する (2 段階)。
    await ctx.postProgress("status", { step: "persist_result" });
    await ctx.saveCheckpoint({ provider_result: providerResult });
  } else {
    await ctx.postProgress("status", { step: "resume_from_checkpoint" });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: SmokeGenerateResult = {
    kind: JOB_KIND_SMOKE_GENERATE,
    model: payload.model,
    output_text: providerResult.output_text,
    usage: providerResult.usage,
    resumed_from_checkpoint: resumed,
  };
  await ctx.complete(result);
};

export function createDefaultHandlers(): JobHandlers {
  return {
    [JOB_KIND_SMOKE_GENERATE]: runSmokeGenerate,
    [JOB_KIND_ORCHESTRATOR_TURN]: runOrchestratorTurn,
    [JOB_KIND_GENERATE_SCENE]: runGenerateScene,
    [JOB_KIND_PLAN_WORK]: runPlanWork,
  };
}

/**
 * ジョブのディスパッチ。未知 kind は即 failed。
 * JobInfraError は呼び出し側へ再送出 (ジョブは leased のまま残り、
 * リース期限切れ後に別の実行体が再開できる)。
 */
export async function runJob(
  job: AgentJob,
  ctx: JobContext,
  handlers: JobHandlers = createDefaultHandlers(),
): Promise<"completed" | "failed"> {
  const handler = handlers[job.kind];
  if (!handler) {
    await safeFail(ctx, `unknown job kind: ${job.kind}`);
    return "failed";
  }
  try {
    await handler(job, ctx);
    return "completed";
  } catch (e) {
    if (e instanceof JobInfraError) throw e;
    await safeFail(ctx, e instanceof Error ? e.message : String(e));
    return "failed";
  }
}

async function safeFail(ctx: JobContext, message: string): Promise<void> {
  try {
    await ctx.fail(message);
  } catch {
    // fail 自体の失敗 (リース切れ等) は握りつぶす — ジョブは再リースされる。
  }
}
