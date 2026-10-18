import {
  AddCanonFactsRequestSchema,
  AppendMessageRequestSchema,
  ApproveChangeSetRequestSchema,
  ApprovePlanProposalResponseSchema,
  ApproveProposalResponseSchema,
  ApproveWorkspaceWriteResponseSchema,
  CompleteRequestSchema,
  CreateChangeSetRequestSchema,
  CreateJobRequestSchema,
  CreateKeyRequestSchema,
  CreateMessageRequestSchema,
  CreateUserKeyRequestSchema,
  CreateWorkRequestSchema,
  CreateProposalRequestSchema,
  CreateRevisionRequestSchema,
  FailRequestSchema,
  HeartbeatRequestSchema,
  JOB_KIND_GENERATE_SCENE,
  JOB_KIND_ORCHESTRATOR_TURN,
  JOB_KIND_REVIEW_CHANGE,
  LeaseRequestSchema,
  PersistRevisionRequestSchema,
  PlanProposalPayloadSchema,
  ProgressRequestSchema,
  RecordStepRequestSchema,
  UpdateAutonomyRequestSchema,
  PROPOSAL_KIND_PLAN,
  PROPOSAL_KIND_WORKSPACE_WRITE,
  PROPOSAL_KIND_WRITING_CONTRACT,
  RecordDependenciesRequestSchema,
  RecordReviewFindingsRequestSchema,
  ResolveKeyRequestSchema,
  RewriteSceneRequestSchema,
  SetFindingStatusRequestSchema,
  TestKeyRequestSchema,
  tiptapDocToText,
  WorkPatchRequestSchema,
  WorkSettingsRequestSchema,
  WorkspaceWriteRequestSchema,
  type AgentJob,
  type ApiErrorCode,
  type PreApplyCheck,
  type Work,
} from "@houchi/contracts";
import {
  buildPlanTree,
  listFiles as listWorkspaceFiles,
  parseCanonStatements,
  PATH_CANON_FACTS,
  readFile as readWorkspaceFile,
  writePropose as workspaceWritePropose,
} from "@houchi/workspace";
import {
  addCanonFacts as repoAddCanonFacts,
  addDependencyEdges,
  addReviewFindings,
  appendMessage,
  appendProgress,
  applyChangeSet,
  completeJob,
  computeChangeSetImpact,
  createChangeSet,
  createEpisode,
  createJob,
  createKey,
  createProposal,
  createRelease,
  createScene,
  createSceneRevision,
  createWork,
  createWritingContract,
  deleteKey,
  failJob,
  findEpisodeByTitle,
  getChangeSetById,
  getChangeSetWithFindings,
  getContractById,
  getEpisodeById,
  getJob,
  getKeyById,
  getLatestContractByScene,
  getLatestEpisode,
  getMessageById,
  getProposalById,
  getReleaseById,
  getReviewFindingById,
  getSceneById,
  getThreadById,
  getThreadByWorkId,
  getUserIdByEmail,
  getWorkById,
  heartbeat,
  insertAgentStep,
  leaseNextJob,
  listAgentStepsByJob,
  listCanonFactsByWork,
  listChangeSetsByWork,
  listContractsByWork,
  listEntitiesWithAliasesByWork,
  listEpisodesByWork,
  listFactRefsByEntityIds,
  listKeyUsageCounts,
  listKeysByOwner,
  listKnowledgeEventsByEntity,
  listKnowledgeEventsByWork,
  listMessages,
  listOpenJobsByWork,
  listProgress,
  listRecentJobsByWork,
  listProposalsByWork,
  listPublicWorkEpisodes,
  listReleasesByWork,
  listRevisionsByScene,
  listRevisionsByWork,
  listScenesByWork,
  listWorksByOwner,
  manualEditImpact,
  patchWork,
  RepoError,
  setReleaseStatus,
  setReviewFindingStatus,
  snapshotEpisodeProse,
  updateChangeSetState,
  updateContractStatus,
  updateProposalStatus,
  updateSceneStatus,
  updateWorkAutonomy,
  updateWorkConfig,
  verifyChangeSetForApply,
  type DbLike,
} from "@houchi/database";
import { decrypt, encrypt, secretsEqual } from "@houchi/secrets";
import {
  createProvider,
  OpenAICompatProvider,
  ProviderError,
} from "@houchi/providers";
import type { Auth } from "./auth.js";

/**
 * apps/web — Studio API + 実行体 API の fetch ハンドラ。
 *
 * 認証は2系統 (spec §9 で分離):
 * - ユーザー向け (/api/works, /api/keys, /api/me ...): better-auth の
 *   HttpOnly Cookie セッション。/api/auth/* は better-auth に委譲する。
 * - 実行体向け (/api/jobs, /api/internal/*): EXECUTOR_TOKEN Bearer。
 */

export interface WebDeps {
  db: DbLike;
  /** APP_SECRET_KEY (base64 の 32 バイト)。 */
  secretKey: string;
  executorToken: string;
  /** better-auth インスタンス (./auth.ts の createAuth)。 */
  auth: Auth;
  /** 開発用ログインの有効化フラグ (DEV_LOGIN_ENABLED=true の時のみ true)。 */
  devLoginEnabled: boolean;
  /** orchestrator_turn の既定モデル (DEFAULT_MODEL)。 */
  defaultModel: string;
  /** リクエストのオリジン (dev-login の内部転送に使う)。 */
  baseUrl: string;
}

export type FetchHandler = (request: Request) => Promise<Response>;

function json(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function err(status: number, code: ApiErrorCode, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function parseBody<T>(
  req: Request,
  schema: { parse(input: unknown): T },
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return err(400, "bad_request", "JSONの形式が正しくありません");
  }
  try {
    return schema.parse(raw);
  } catch {
    return err(400, "bad_request", "入力内容が不正です");
  }
}

/** lease_token は認証情報なので API 応答からは取り除く。 */
function publicJob(job: AgentJob): AgentJob {
  return { ...job, lease_token: null };
}

function repoError(e: unknown): Response {
  if (e instanceof RepoError) {
    const status =
      e.code === "not_found"
        ? 404
        : e.code === "lease_conflict" || e.code === "conflict"
          ? 409
          : 500;
    return err(status, e.code, e.message);
  }
  return err(500, "internal", "予期しないエラーが発生しました");
}

/** dev-login で作る固定開発ユーザーの識別子。 */
const DEV_USER_EMAIL = "dev@houchi-sakka.local";
const DEV_USER_NAME = "開発ユーザー";
const DEV_USER_PASSWORD = "dev-login-password";

export function createApp(deps: WebDeps): FetchHandler {
  const { db, secretKey, executorToken, auth } = deps;

  /**
   * プロバイダー別の既定モデル。model 未指定時のフォールバックに使う
   * (env DEFAULT_MODEL は OpenAI 向け既定なので他社キーには合わない)。
   */
  const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
    gemini: "gemini-2.5-flash",
    anthropic: "claude-haiku-4-5",
    openrouter: "meta-llama/llama-3.3-70b-instruct:free",
    // llama-3.3-70b-versatile は 2026-08 に廃止済み → gpt-oss-120b が
    // Groq 公式の代替推奨モデル。
    groq: "openai/gpt-oss-120b",
    github: "gpt-4o-mini",
  };
  const defaultModelFor = (provider: string | null | undefined): string =>
    (provider && PROVIDER_DEFAULT_MODEL[provider]) || deps.defaultModel;

  /** 自律運転の停止通知を対話スレッドへ残す (spec §7.3: 停止理由を保存)。 */
  const stopAutonomy = async (work: Work, reason: string): Promise<void> => {
    await updateWorkAutonomy(db, { id: work.id, level: "off", budget: 0 });
    const thread = await getThreadByWorkId(db, work.id);
    if (thread) {
      await appendMessage(db, {
        threadId: thread.id,
        role: "system",
        content: `自律実行を停止しました (${reason})`,
      });
    }
  };

  /**
   * 自律運転 Draft only (spec §7.2/§7.3): ジョブ完了ごとに継続判定し、
   * 次の自律 orchestrator_turn を起票する。停止条件:
   * 実行上限・<<AUTO_STOP>>・副作用なしの応答 (作者の判断待ち)。
   * 失敗時の停止は fail 側で行う。継続はベストエフォート (起票失敗で
   * 完了応答を壊さないよう呼び出し側で握る)。
   */
  const maybeContinueAutonomy = async (completed: AgentJob): Promise<void> => {
    if (!completed.work_ref) return;
    const work = await getWorkById(db, completed.work_ref);
    if (!work || work.autonomy_level !== "draft") return;

    const result = (completed.result ?? null) as {
      auto_stop?: boolean;
      actions?: string[];
    } | null;

    if (work.autonomy_budget <= 0) {
      await stopAutonomy(work, "実行上限に達しました");
      return;
    }
    if (result?.auto_stop === true) {
      await stopAutonomy(work, "オーケストレーターが終了を選択しました");
      return;
    }
    // 自律往復が副作用なしの返答だけ = 作者の入力待ち → 停止 (spec §7.3)。
    if (
      completed.kind === JOB_KIND_ORCHESTRATOR_TURN &&
      completed.payload.autonomous === true &&
      result !== null &&
      Array.isArray(result.actions) &&
      result.actions.length === 0
    ) {
      await stopAutonomy(work, "作者の判断または返答が必要です");
      return;
    }

    const thread = await getThreadByWorkId(db, work.id);
    if (!thread) {
      await stopAutonomy(work, "対話スレッドが見つかりません");
      return;
    }
    // キー/モデルは現在の作品設定を優先し、直前ジョブ→最新キーの順に落ちる
    // (再送と同じ解決順。設定修正が次の往復に効く)。
    const p = completed.payload;
    let key = work.key_ref ? await getKeyById(db, work.key_ref) : null;
    if ((!key || key.owner_ref !== work.owner_ref) && typeof p.key_ref === "string") {
      const k = await getKeyById(db, p.key_ref);
      if (k && k.owner_ref === work.owner_ref) key = k;
    }
    if (!key || key.owner_ref !== work.owner_ref) {
      key = (await listKeysByOwner(db, work.owner_ref)).at(-1) ?? null;
    }
    if (!key) {
      await stopAutonomy(work, "利用できるAPIキーがありません");
      return;
    }

    await updateWorkAutonomy(db, {
      id: work.id,
      budget: work.autonomy_budget - 1,
    });
    await createJob(db, {
      kind: JOB_KIND_ORCHESTRATOR_TURN,
      workRef: work.id,
      userRef: work.owner_ref,
      payload: {
        thread_id: thread.id,
        work_id: work.id,
        user_ref: work.owner_ref,
        key_ref: key.id,
        provider: key.provider,
        model:
          work.model ??
          (typeof p.model === "string"
            ? p.model
            : defaultModelFor(key.provider)),
        autonomous: true,
      },
      // 完了したジョブごとに一意 → 同一完了からの二重継続を抑止
      idempotencyKey: `auto_turn:${completed.id}`,
    });
  };

  const authorizedExecutor = async (req: Request): Promise<boolean> => {
    const h = req.headers.get("authorization");
    if (!h?.startsWith("Bearer ")) return false;
    return secretsEqual(h.slice(7).trim(), executorToken);
  };

  /** セッションユーザーを取る。未ログインは null。 */
  const sessionUser = async (req: Request) => {
    const s = await auth.api.getSession({ headers: req.headers });
    return s?.user ?? null;
  };

  /**
   * generate_scene ジョブをキューする。キーは作品設定 → ユーザーの最新キー
   * の順で引く (キー未登録なら null を返す)。
   */
  const enqueueGenerateScene = async (input: {
    work: { id: string; owner_ref: string; key_ref: string | null; model: string | null };
    sceneId: string;
    contractId: string;
    instruction?: string;
    idempotencyKey: string;
  }) => {
    const keys = await listKeysByOwner(db, input.work.owner_ref);
    const workKey = input.work.key_ref
      ? await getKeyById(db, input.work.key_ref)
      : undefined;
    const key =
      workKey && workKey.owner_ref === input.work.owner_ref
        ? workKey
        : keys.at(-1);
    if (!key) return null;
    const { job } = await createJob(db, {
      kind: JOB_KIND_GENERATE_SCENE,
      workRef: input.work.id,
      userRef: input.work.owner_ref,
      payload: {
        scene_id: input.sceneId,
        contract_id: input.contractId,
        work_id: input.work.id,
        user_ref: input.work.owner_ref,
        key_ref: key.id,
        provider: key.provider,
        model: input.work.model ?? defaultModelFor(key.provider),
        ...(input.instruction !== undefined
          ? { instruction: input.instruction }
          : {}),
      },
      idempotencyKey: input.idempotencyKey,
    });
    return job;
  };

  /**
   * review_change ジョブをキューする (Phase 2b)。
   * 変更セット適用/手編集の直後に自動起票し、影響シーンと新正典を
   * critic で検査させる。キー未登録なら null (起票しない)。
   */
  const enqueueReviewChange = async (input: {
    work: {
      id: string;
      owner_ref: string;
      key_ref: string | null;
      model: string | null;
    };
    changeSetId: string;
  }) => {
    const keys = await listKeysByOwner(db, input.work.owner_ref);
    const workKey = input.work.key_ref
      ? await getKeyById(db, input.work.key_ref)
      : undefined;
    const key =
      workKey && workKey.owner_ref === input.work.owner_ref
        ? workKey
        : keys.at(-1);
    if (!key) return null;
    const { job } = await createJob(db, {
      kind: JOB_KIND_REVIEW_CHANGE,
      workRef: input.work.id,
      userRef: input.work.owner_ref,
      payload: {
        change_set_id: input.changeSetId,
        work_id: input.work.id,
        user_ref: input.work.owner_ref,
        key_ref: key.id,
        provider: key.provider,
        model: input.work.model ?? defaultModelFor(key.provider),
      },
      idempotencyKey: `review_change:${input.changeSetId}`,
    });
    return job;
  };

  /**
   * dev-login: 固定開発ユーザーでセッションを発行する。
   * better-auth の emailAndPassword 経路 (DEV_LOGIN_ENABLED 時のみ有効化) に
   * 内部転送し、返ってきた Set-Cookie をそのまま利用者に渡す。
   */
  const devLogin = async (): Promise<Response> => {
    if (!deps.devLoginEnabled) {
      return err(404, "not_found", "見つかりません");
    }
    const exists = (await getUserIdByEmail(db, DEV_USER_EMAIL)) !== null;
    const path = exists ? "sign-in/email" : "sign-up/email";
    const body = exists
      ? { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD }
      : {
          email: DEV_USER_EMAIL,
          password: DEV_USER_PASSWORD,
          name: DEV_USER_NAME,
        };
    const inner = await auth.handler(
      new Request(`${deps.baseUrl}/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!inner.ok) {
      return err(500, "internal", "開発用ログインに失敗しました");
    }
    const setCookie = inner.headers.get("set-cookie");
    if (!setCookie) {
      return err(500, "internal", "開発用ログインでセッションを取得できませんでした");
    }
    return json({ ok: true }, 200, { "set-cookie": setCookie });
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    try {
      if (method === "GET" && pathname === "/api/healthz") {
        return json({ ok: true });
      }

      // better-auth のハンドラ (sign-in/social, sign-out, get-session 等)
      if (pathname.startsWith("/api/auth/")) {
        return await auth.handler(request);
      }

      // GET /api/config — ログイン不要の公開設定
      if (method === "GET" && pathname === "/api/config") {
        return json({ dev_login_enabled: deps.devLoginEnabled });
      }

      // POST /api/dev/login — 開発用ワンクリックログイン (flag 必須)
      if (method === "POST" && pathname === "/api/dev/login") {
        return await devLogin();
      }

      /**
       * GET /api/r/:id — 読者向けの公開リリース (ログイン不要)。
       * spec P9/§9: published のみ、安全なフィールド (タイトル・話名・
       * 本文・公開日) だけを返す。正典・ユーザー情報・下書きは出さない。
       */
      const publicRelease = pathname.match(/^\/api\/r\/([^/]+)$/);
      if (method === "GET" && publicRelease) {
        const release = await getReleaseById(db, publicRelease[1]!);
        if (!release || release.status !== "published") {
          return err(404, "not_found", "見つかりません");
        }
        const work = await getWorkById(db, release.work_id);
        if (!work) return err(404, "not_found", "見つかりません");
        return json({
          release: {
            id: release.id,
            work_title: work.title,
            title: release.title,
            rev_no: release.rev_no,
            published_at: release.published_at,
            scenes: release.content,
          },
        });
      }

      /**
       * GET /api/w/:id — 読者向けの作品公開目次 (ログイン不要)。
       * 話ごとの最新 published リリースと版数だけを返す。
       * published が 1 件も無い作品は存在自体を出さず 404 (spec P9)。
       */
      const publicWork = pathname.match(/^\/api\/w\/([^/]+)$/);
      if (method === "GET" && publicWork) {
        const work = await getWorkById(db, publicWork[1]!);
        if (!work) return err(404, "not_found", "not found");
        const episodes = await listPublicWorkEpisodes(db, work.id);
        if (episodes.length === 0) {
          return err(404, "not_found", "not found");
        }
        return json({
          work: { id: work.id, title: work.title, premise: work.premise },
          episodes,
        });
      }

      // -------------------------------------------------------------------
      // ユーザー向け API (セッション認証)
      // -------------------------------------------------------------------
      const userScoped =
        pathname === "/api/me" ||
        pathname === "/api/works" ||
        pathname.startsWith("/api/works/") ||
        pathname === "/api/keys" ||
        pathname.startsWith("/api/keys/") ||
        pathname.startsWith("/api/proposals/") ||
        pathname.startsWith("/api/scenes/") ||
        pathname.startsWith("/api/releases/") ||
        pathname.startsWith("/api/change-sets/") ||
        pathname.startsWith("/api/review-findings/");
      if (userScoped) {
        const user = await sessionUser(request);
        if (!user) return err(401, "unauthorized", "ログインが必要です");

        if (method === "GET" && pathname === "/api/me") {
          return json({
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              image: user.image ?? null,
            },
          });
        }

        // GET /api/works — 自分の作品一覧
        if (method === "GET" && pathname === "/api/works") {
          const works = await listWorksByOwner(db, user.id);
          return json({ works });
        }

        // POST /api/works — 作品作成 (+対話スレッド)
        if (method === "POST" && pathname === "/api/works") {
          const body = await parseBody(request, CreateWorkRequestSchema);
          if (body instanceof Response) return body;
          // 既定のキーがあれば作品の provider/key_ref として初期化する
          // (設定タブで後から変更可)。
          const keys = await listKeysByOwner(db, user.id);
          const defaultKey = keys.at(-1);
          const { work, thread } = await createWork(db, {
            ownerRef: user.id,
            title: body.title,
            ...(body.premise !== undefined ? { premise: body.premise } : {}),
            model: defaultModelFor(defaultKey?.provider),
            ...(defaultKey
              ? { provider: defaultKey.provider, keyRef: defaultKey.id }
              : {}),
          });
          // 対話開始の入口として、オーケストレーターの案内文を最初に置く
          // (LLM は呼ばない固定文。spec §4.1: 作品は対話から開始する)。
          await appendMessage(db, {
            threadId: thread.id,
            role: "assistant",
            content:
              "この作品の前提を一緒に固めましょう。どんな物語を書きたいですか?" +
              "テーマや読者に味わってほしい体験、結末の希望、確定したい要素があれば教えてください。",
          });
          return json({ work }, 201);
        }

        const workPath = pathname.match(/^\/api\/works\/([^/]+)$/);
        const workMsgPath = pathname.match(
          /^\/api\/works\/([^/]+)\/messages$/,
        );

        // GET /api/works/:id — 作品+スレッド+メッセージ+実行中ジョブ
        if (method === "GET" && workPath) {
          const work = await getWorkById(db, workPath[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const thread = await getThreadByWorkId(db, work.id);
          if (!thread) return err(500, "internal", "対話スレッドが見つかりません");
          const messages = await listMessages(db, thread.id);
          const openJobs = await listOpenJobsByWork(db, work.id);
          const recentJobs = await listRecentJobsByWork(db, work.id);
          const proposals = await listProposalsByWork(db, work.id);
          const changeSets = await listChangeSetsByWork(db, work.id);
          const active = openJobs[0] ?? null;
          return json({
            work,
            thread,
            messages,
            proposals,
            change_sets: changeSets,
            active_job: active
              ? {
                  job: publicJob(active),
                  progress: (await listProgress(db, active.id)).slice(-50),
                }
              : null,
            queued_jobs: Math.max(0, openJobs.length - 1),
            recent_jobs: recentJobs.map(publicJob),
          });
        }

        // POST /api/works/:id/messages — 送信→orchestrator_turn をキュー
        if (method === "POST" && workMsgPath) {
          const body = await parseBody(request, CreateMessageRequestSchema);
          if (body instanceof Response) return body;
          const work = await getWorkById(db, workMsgPath[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const thread = await getThreadByWorkId(db, work.id);
          if (!thread) return err(500, "internal", "対話スレッドが見つかりません");

          let key;
          if (body.key_id) {
            key = await getKeyById(db, body.key_id);
            if (!key || key.owner_ref !== user.id) {
              return err(400, "bad_request", "指定したキーが見つかりません");
            }
          } else {
            // 作品設定のキーを優先し、無効/未設定ならユーザーの最新キー
            // (generate_scene / review_change と同じ解決順)。
            const workKey = work.key_ref
              ? await getKeyById(db, work.key_ref)
              : null;
            key =
              workKey && workKey.owner_ref === user.id
                ? workKey
                : (await listKeysByOwner(db, user.id)).at(-1);
          }
          if (!key) {
            return err(
              400,
              "bad_request",
              "プロバイダーのAPIキーが未登録です。キー設定から登録してください",
            );
          }

          const message = await appendMessage(db, {
            threadId: thread.id,
            role: "user",
            content: body.content,
          });
          // 対話送信で作品は setup → active に遷移する (Phase 1a の最小遷移)
          if (work.status === "setup") {
            await patchWork(db, { id: work.id, status: "active" });
          }
          const { job } = await createJob(db, {
            kind: JOB_KIND_ORCHESTRATOR_TURN,
            workRef: work.id,
            userRef: user.id,
            payload: {
              thread_id: thread.id,
              work_id: work.id,
              user_ref: user.id,
              key_ref: key.id,
              provider: key.provider,
              model:
                body.model ?? work.model ?? defaultModelFor(key.provider),
              trigger_message_id: message.id,
            },
            // 同一メッセージからの重複ジョブを抑止
            idempotencyKey: `orchestrator_turn:${message.id}`,
          });
          return json({ message, job: publicJob(job) }, 202);
        }

        /**
         * POST /api/works/:id/jobs/:jobId/resend — 失敗/中止した対話
         * (orchestrator_turn) ジョブを、元メッセージと同じ内容の新規
         * メッセージ+ジョブとして投げ直す (spec §3.4 の再送導線)。
         * 冪等は通常送信と同じく message 単位の idempotency_key に乗せる。
         */
        const jobResend = pathname.match(
          /^\/api\/works\/([^/]+)\/jobs\/([^/]+)\/resend$/,
        );
        if (method === "POST" && jobResend) {
          const work = await getWorkById(db, jobResend[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const oldJob = await getJob(db, jobResend[2]!);
          if (!oldJob || oldJob.work_ref !== work.id) {
            return err(404, "not_found", "見つかりません");
          }
          if (oldJob.kind !== JOB_KIND_ORCHESTRATOR_TURN) {
            return err(400, "bad_request", "対話ジョブのみ再送できます");
          }
          if (oldJob.status !== "failed" && oldJob.status !== "cancelled") {
            return err(
              400,
              "bad_request",
              "失敗または中止したジョブのみ再送できます",
            );
          }
          const triggerId = oldJob.payload.trigger_message_id;
          const original =
            typeof triggerId === "string"
              ? await getMessageById(db, triggerId)
              : null;
          if (!original) {
            return err(
              404,
              "not_found",
              "元のメッセージが見つかりません",
            );
          }
          const thread = await getThreadByWorkId(db, work.id);
          if (!thread) return err(500, "internal", "対話スレッドが見つかりません");

          // キーは現在の作品設定を最優先 (設定修正後の再送を救うため)。
          // 無ければ元ジョブのキー、それも無効なら最新キーに落ちる。
          let key = null;
          if (work.key_ref) {
            const k = await getKeyById(db, work.key_ref);
            if (k && k.owner_ref === user.id) key = k;
          }
          if (!key && typeof oldJob.payload.key_ref === "string") {
            const k = await getKeyById(db, oldJob.payload.key_ref);
            if (k && k.owner_ref === user.id) key = k;
          }
          if (!key) {
            const keys = await listKeysByOwner(db, user.id);
            key = keys.at(-1) ?? null;
          }
          if (!key) {
            return err(
              400,
              "bad_request",
              "プロバイダーのAPIキーが未登録です。キー設定から登録してください",
            );
          }

          const message = await appendMessage(db, {
            threadId: thread.id,
            role: "user",
            content: original.content,
          });
          if (work.status === "setup") {
            await patchWork(db, { id: work.id, status: "active" });
          }
          const { job } = await createJob(db, {
            kind: JOB_KIND_ORCHESTRATOR_TURN,
            workRef: work.id,
            userRef: user.id,
            payload: {
              thread_id: thread.id,
              work_id: work.id,
              user_ref: user.id,
              key_ref: key.id,
              provider: key.provider,
              // モデルも現在の作品設定を最優先。旧ペイロードに
              // プロバイダー非互換の名前が残っていても救済される。
              model:
                work.model ??
                (typeof oldJob.payload.model === "string"
                  ? oldJob.payload.model
                  : defaultModelFor(key.provider)),
              trigger_message_id: message.id,
              resend_of: oldJob.id,
            },
            // 新しいメッセージに紐づくので通常送信と同じ冪等キーで二重防止
            idempotencyKey: `orchestrator_turn:${message.id}`,
          });
          return json({ message, job: publicJob(job) }, 202);
        }

        /**
         * GET /api/works/:id/jobs/:jobId — ジョブ詳細+実行ステップ一覧
         * (spec §7.4 の AgentStep を履歴表示で展開するため)。
         */
        const workJob = pathname.match(
          /^\/api\/works\/([^/]+)\/jobs\/([^/]+)$/,
        );
        if (method === "GET" && workJob) {
          const work = await getWorkById(db, workJob[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const job = await getJob(db, workJob[2]!);
          if (!job || job.work_ref !== work.id) {
            return err(404, "not_found", "見つかりません");
          }
          const steps = await listAgentStepsByJob(db, job.id);
          return json({ job: publicJob(job), steps });
        }

        /**
         * POST /api/works/:id/autonomy — 自律運転の開始/停止
         * (spec §7.2 Draft only。開始時に実行上限を明示して最初の自律
         * 往復を起票する)。
         */
        const workAutonomy = pathname.match(
          /^\/api\/works\/([^/]+)\/autonomy$/,
        );
        if (method === "POST" && workAutonomy) {
          const work = await getWorkById(db, workAutonomy[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const body = await parseBody(request, UpdateAutonomyRequestSchema);
          if (body instanceof Response) return body;
          if (body.action === "stop") {
            const updated = await updateWorkAutonomy(db, {
              id: work.id,
              level: "off",
              budget: 0,
            });
            return json({ work: updated });
          }
          if (work.autonomy_level === "draft") {
            return err(400, "bad_request", "既に自律実行中です");
          }
          const thread = await getThreadByWorkId(db, work.id);
          if (!thread) {
            return err(500, "internal", "対話スレッドが見つかりません");
          }
          // キー解決は対話送信と同じ (作品設定→最新キー)。
          const workKey = work.key_ref
            ? await getKeyById(db, work.key_ref)
            : null;
          const key =
            workKey && workKey.owner_ref === user.id
              ? workKey
              : (await listKeysByOwner(db, user.id)).at(-1);
          if (!key) {
            return err(
              400,
              "bad_request",
              "プロバイダーのAPIキーが未登録です。キー設定から登録してください",
            );
          }
          const maxTurns = body.max_turns ?? 10;
          const updated = await updateWorkAutonomy(db, {
            id: work.id,
            level: "draft",
            // この直後に1往復目を起票するので残りは maxTurns-1
            budget: maxTurns - 1,
          });
          await createJob(db, {
            kind: JOB_KIND_ORCHESTRATOR_TURN,
            workRef: work.id,
            userRef: user.id,
            payload: {
              thread_id: thread.id,
              work_id: work.id,
              user_ref: user.id,
              key_ref: key.id,
              provider: key.provider,
              model: work.model ?? defaultModelFor(key.provider),
              autonomous: true,
            },
            idempotencyKey: `auto_start:${work.id}:${crypto.randomUUID()}`,
          });
          await appendMessage(db, {
            threadId: thread.id,
            role: "system",
            content: `自律実行を開始しました (上限 ${maxTurns} 往復)。草案や提案の作成まで自動で進め、確定が必要な場面では停止します。`,
          });
          return json({ work: updated });
        }

        // GET /api/keys — 自分のキー一覧 (ciphertext は絶対返さない)。
        // works_using は削除時の影響表示用 (spec §9)。
        if (method === "GET" && pathname === "/api/keys") {
          const keys = await listKeysByOwner(db, user.id);
          const usage = await listKeyUsageCounts(db, user.id);
          return json({
            keys: keys.map(({ ciphertext: _drop, ...pub }) => ({
              ...pub,
              works_using: usage.get(pub.id) ?? 0,
            })),
          });
        }

        // POST /api/keys — キー登録 (暗号化して保存)
        if (method === "POST" && pathname === "/api/keys") {
          const body = await parseBody(request, CreateUserKeyRequestSchema);
          if (body instanceof Response) return body;
          // custom は OpenAI 互換エンドポイントの base_url が必須
          if (body.provider === "custom" && !body.base_url) {
            return err(
              400,
              "bad_request",
              "カスタムプロバイダーにはエンドポイントURL (OpenAI互換) が必要です",
            );
          }
          const ciphertext = await encrypt(body.api_key, secretKey);
          const key = await createKey(db, {
            ownerRef: user.id,
            label: body.label,
            provider: body.provider,
            ...(body.base_url !== undefined
              ? { baseUrl: body.base_url }
              : {}),
            ciphertext,
          });
          const { ciphertext: _drop, ...pub } = key;
          return json({ key: pub }, 201);
        }

        /**
         * POST /api/keys/:id/test — キー疎通テスト。
         * 自分のキーを復号して最小プロンプトを 1 回実行し、実プロバイダー
         * アダプター経路の成否とエラー本文を返す。
         * 注意: テストは Worker 側から発するので、localhost 系 base_url
         * (ローカル runner にしか届かない) では必ず失敗する。
         */
        const keyTest = pathname.match(/^\/api\/keys\/([^/]+)\/test$/);
        if (method === "POST" && keyTest) {
          const body = await parseBody(request, TestKeyRequestSchema);
          if (body instanceof Response) return body;
          const key = await getKeyById(db, keyTest[1]!);
          if (!key || key.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const providerName = key.provider || "openai";
          const provider = key.base_url
            ? new OpenAICompatProvider({
                baseURL: key.base_url,
                name: providerName,
              })
            : createProvider(providerName);
          if (!provider) {
            return err(400, "bad_request", `未知のプロバイダー: ${providerName}`);
          }
          const model = body.model ?? defaultModelFor(providerName);
          const apiKey = await decrypt(key.ciphertext, secretKey);
          const t0 = Date.now();
          const timeout = new Promise<never>((_r, rej) =>
            setTimeout(
              () => rej(new ProviderError("テストがタイムアウトしました (30s)")),
              30000,
            ),
          );
          try {
            const res = await Promise.race([
              provider.generate(
                {
                  model,
                  input: [{ role: "user", content: "ok とだけ返答してください" }],
                },
                apiKey,
              ),
              timeout,
            ]);
            return json({
              ok: true,
              provider: providerName,
              model,
              ms: Date.now() - t0,
              response: (res.output_text ?? "").slice(0, 200),
            });
          } catch (e) {
            return json({
              ok: false,
              provider: providerName,
              model,
              ms: Date.now() - t0,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        // DELETE /api/keys/:id — 自分のキーだけ消せる
        const keyDelete = pathname.match(/^\/api\/keys\/([^/]+)$/);
        if (method === "DELETE" && keyDelete) {
          const deleted = await deleteKey(db, {
            id: keyDelete[1]!,
            ownerRef: user.id,
          });
          if (!deleted) return err(404, "not_found", "見つかりません");
          return json({ ok: true });
        }

        // GET /api/works/:id/prose — 本文タブ用の話/シーン/リビジョン/契約/正典
        const workProse = pathname.match(/^\/api\/works\/([^/]+)\/prose$/);
        if (method === "GET" && workProse) {
          const work = await getWorkById(db, workProse[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const episodes = await listEpisodesByWork(db, work.id);
          const scenes = await listScenesByWork(db, work.id);
          const revisions = await listRevisionsByWork(db, work.id);
          const contracts = await listContractsByWork(db, work.id);
          const canonFacts = await listCanonFactsByWork(db, work.id);
          return json({
            episodes,
            scenes,
            revisions,
            contracts,
            canon_facts: canonFacts,
          });
        }

        // GET /api/works/:id/workspace/files — 資料タブ用の仮想ファイル一覧
        const workspaceFilesPath = pathname.match(
          /^\/api\/works\/([^/]+)\/workspace\/files$/,
        );
        if (method === "GET" && workspaceFilesPath) {
          const work = await getWorkById(db, workspaceFilesPath[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const files = await listWorkspaceFiles(db, work);
          return json({ files });
        }

        // GET /api/works/:id/workspace/file?path= — 仮想ファイルの内容
        const workspaceFilePath = pathname.match(
          /^\/api\/works\/([^/]+)\/workspace\/file$/,
        );
        if (method === "GET" && workspaceFilePath) {
          const work = await getWorkById(db, workspaceFilePath[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const filePath = url.searchParams.get("path") ?? "";
          const file = await readWorkspaceFile(db, work, filePath);
          if (!file) return err(404, "not_found", "ファイルが見つかりません");
          return json(file);
        }

        // GET /api/works/:id/entities — 資料タブ「登場要素」の一覧+詳細
        // (名前・別名・要約・紐付く正典・知識イベント。読み取り専用: 構造化
        // 情報の CRUD は対話経由のみ, spec P1)。
        const entitiesPath = pathname.match(
          /^\/api\/works\/([^/]+)\/entities$/,
        );
        if (method === "GET" && entitiesPath) {
          const work = await getWorkById(db, entitiesPath[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const entities = await listEntitiesWithAliasesByWork(db, work.id);
          const facts = await listCanonFactsByWork(db, work.id);
          const factByRef = new Map(
            facts.map((f) => [f.fact_ref ?? f.id, f]),
          );
          const linkMap = await listFactRefsByEntityIds(
            db,
            entities.map((e) => e.entity_id),
          );
          const scenes = await listScenesByWork(db, work.id);
          const sceneTitle = new Map(scenes.map((s) => [s.id, s.title]));
          const detailed = [];
          for (const e of entities) {
            const linked = (linkMap.get(e.entity_id) ?? [])
              .map((ref) => factByRef.get(ref))
              .filter((f) => f !== undefined);
            const events = await listKnowledgeEventsByEntity(
              db,
              e.entity_id,
            );
            detailed.push({
              id: e.id,
              entity_id: e.entity_id,
              kind: e.kind,
              name: e.name,
              summary: e.summary,
              aliases: e.aliases,
              facts: linked,
              knowledge_events: events.map((ev) => ({
                ...ev,
                fact_statement:
                  factByRef.get(ev.fact_id)?.statement ?? null,
                scene_title: ev.scene_id
                  ? (sceneTitle.get(ev.scene_id) ?? null)
                  : null,
              })),
            });
          }
          return json({ entities: detailed });
        }

        // PATCH /api/works/:id/settings — provider/model/key の選択
        const workSettings = pathname.match(
          /^\/api\/works\/([^/]+)\/settings$/,
        );
        if (method === "PATCH" && workSettings) {
          const body = await parseBody(request, WorkSettingsRequestSchema);
          if (body instanceof Response) return body;
          const work = await getWorkById(db, workSettings[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          let keyRef: string | null | undefined;
          let provider: string | null | undefined;
          if (body.key_id !== undefined) {
            if (body.key_id === null) {
              keyRef = null;
              provider = null;
            } else {
              const key = await getKeyById(db, body.key_id);
              if (!key || key.owner_ref !== user.id) {
                return err(400, "bad_request", "指定したキーが見つかりません");
              }
              keyRef = key.id;
              provider = key.provider;
            }
          }
          const updated = await updateWorkConfig(db, {
            id: work.id,
            ...(keyRef !== undefined ? { keyRef } : {}),
            ...(provider !== undefined ? { provider } : {}),
            // キー切替でプロバイダーが変わり model 指定が無い時は
            // 旧モデル名 (例 gpt-4o-mini) が新プロバイダーでは404になるため
            // プロバイダー既定に合わせる。
            ...(body.model !== undefined
              ? { model: body.model }
              : provider != null && provider !== work.provider
                ? { model: defaultModelFor(provider) }
                : {}),
          });
          return json({ work: updated });
        }

        // POST /api/proposals/:id/(approve|reject) — 提案カードの決定
        const proposalAction = pathname.match(
          /^\/api\/proposals\/([^/]+)\/(approve|reject)$/,
        );
        if (method === "POST" && proposalAction) {
          const [, proposalId, action] = proposalAction as unknown as [
            string,
            string,
            string,
          ];
          const proposal = await getProposalById(db, proposalId);
          if (!proposal) return err(404, "not_found", "見つかりません");
          const work = await getWorkById(db, proposal.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          if (proposal.status !== "pending") {
            return err(400, "bad_request", "この提案はすでに決定済みです");
          }

          // --- kind="plan": 計画提案の承認で episodes/scenes を一括作成 ---
          if (proposal.kind === PROPOSAL_KIND_PLAN) {
            if (action === "reject") {
              const updated = await updateProposalStatus(db, {
                id: proposal.id,
                status: "rejected",
              });
              await appendMessage(db, {
                threadId: proposal.thread_id,
                role: "assistant",
                content:
                  "計画案を却下しました。どこを変えますか? " +
                  "対話で指示をもらえれば、もう一度計画を立て直せます。",
              });
              return json({ proposal: updated });
            }
            const planParsed = PlanProposalPayloadSchema.safeParse(
              proposal.payload,
            );
            if (!planParsed.success) {
              return err(500, "internal", "計画提案の内容が不正です");
            }
            const episodes = [];
            const scenes = [];
            for (const ep of planParsed.data.episodes) {
              const episode = await createEpisode(db, {
                workId: work.id,
                title: ep.title,
              });
              episodes.push(episode);
              for (const sc of ep.scenes) {
                scenes.push(
                  await createScene(db, {
                    episodeId: episode.id,
                    title: sc.title,
                    purpose: sc.purpose,
                    status: "draft",
                  }),
                );
              }
            }
            const updatedProposal = await updateProposalStatus(db, {
              id: proposal.id,
              status: "approved",
            });
            await appendMessage(db, {
              threadId: proposal.thread_id,
              role: "assistant",
              content: `計画を承認しました。話 ${episodes.length}件・シーン ${scenes.length}件を作成しました。`,
            });
            const body = ApprovePlanProposalResponseSchema.parse({
              proposal: updatedProposal,
              episodes,
              scenes,
            });
            return json(body);
          }

          // --- kind="workspace_write": workspace 書き込み提案の決定 ---
          if (proposal.kind === PROPOSAL_KIND_WORKSPACE_WRITE) {
            const wp = proposal.payload as {
              path?: string;
              content?: string;
              supported?: boolean;
            };
            if (action === "reject") {
              const updated = await updateProposalStatus(db, {
                id: proposal.id,
                status: "rejected",
              });
              await appendMessage(db, {
                threadId: proposal.thread_id,
                role: "assistant",
                content: `資料「${wp.path ?? ""}」への書き込み提案を却下しました。`,
              });
              return json({ proposal: updated });
            }
            // /canon/facts.md への追記のみ apply 可能
            if (wp.supported !== true || wp.path !== PATH_CANON_FACTS) {
              const updated = await updateProposalStatus(db, {
                id: proposal.id,
                status: "approved",
              });
              await appendMessage(db, {
                threadId: proposal.thread_id,
                role: "assistant",
                content: `資料「${wp.path ?? ""}」への書き込みはまだ対応していないため、提案は記録のみ残しました。`,
              });
              const body = ApproveWorkspaceWriteResponseSchema.parse({
                proposal: updated,
                added: 0,
              });
              return json(body);
            }
            const statements = parseCanonStatements(wp.content ?? "");
            const { added } = await repoAddCanonFacts(db, {
              workId: work.id,
              statements,
              provenance: `workspace_write:${proposal.id}`,
            });
            const updatedProposal = await updateProposalStatus(db, {
              id: proposal.id,
              status: "approved",
            });
            await appendMessage(db, {
              threadId: proposal.thread_id,
              role: "assistant",
              content: `正典に ${added} 件追加しました。`,
            });
            const body = ApproveWorkspaceWriteResponseSchema.parse({
              proposal: updatedProposal,
              added,
            });
            return json(body);
          }

          // --- kind="writing_contract": 契約・シーン承認で本文生成を投下 ---
          const p = proposal.payload as {
            episode_id?: string;
            scene_id?: string;
            contract_id?: string;
          };
          if (!p.scene_id || !p.contract_id || !p.episode_id) {
            return err(500, "internal", "提案内容が不完全です");
          }

          if (action === "reject") {
            await updateContractStatus(db, {
              id: p.contract_id,
              status: "rejected",
            });
            await updateSceneStatus(db, { id: p.scene_id, status: "draft" });
            const updated = await updateProposalStatus(db, {
              id: proposal.id,
              status: "rejected",
            });
            await appendMessage(db, {
              threadId: proposal.thread_id,
              role: "assistant",
              content:
                "提案を却下しました。どこを直しますか? " +
                "シーンの内容や契約の条件を対話で修正して、もう一度提案できます。",
            });
            return json({ proposal: updated });
          }

          // approve: 契約・シーンを approved にし generate_scene を投下
          await updateContractStatus(db, {
            id: p.contract_id,
            status: "approved",
          });
          await updateSceneStatus(db, { id: p.scene_id, status: "approved" });
          const updatedProposal = await updateProposalStatus(db, {
            id: proposal.id,
            status: "approved",
          });
          const job = await enqueueGenerateScene({
            work,
            sceneId: p.scene_id,
            contractId: p.contract_id,
            idempotencyKey: `generate_scene:${p.scene_id}:${p.contract_id}`,
          });
          if (!job) {
            return err(
              400,
              "bad_request",
              "プロバイダーのAPIキーが未登録です。キー設定から登録してください",
            );
          }
          const [episode, scene, contract] = await Promise.all([
            getEpisodeById(db, p.episode_id),
            getSceneById(db, p.scene_id),
            getContractById(db, p.contract_id),
          ]);
          const body = ApproveProposalResponseSchema.parse({
            proposal: updatedProposal,
            episode,
            scene,
            contract,
            job: publicJob(job),
          });
          return json(body);
        }

        // POST /api/scenes/:id/rewrite — 指示付きの書き直し (新リビジョン)
        const sceneRewrite = pathname.match(
          /^\/api\/scenes\/([^/]+)\/rewrite$/,
        );
        if (method === "POST" && sceneRewrite) {
          const body = await parseBody(request, RewriteSceneRequestSchema);
          if (body instanceof Response) return body;
          const scene = await getSceneById(db, sceneRewrite[1]!);
          if (!scene) return err(404, "not_found", "見つかりません");
          const episode = await getEpisodeById(db, scene.episode_id);
          if (!episode) return err(404, "not_found", "見つかりません");
          const work = await getWorkById(db, episode.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const contract = await getLatestContractByScene(db, scene.id);
          if (!contract || contract.status !== "approved") {
            return err(
              400,
              "bad_request",
              "承認済みの Writing Contract がありません",
            );
          }
          const job = await enqueueGenerateScene({
            work,
            sceneId: scene.id,
            contractId: contract.id,
            instruction: body.instruction,
            idempotencyKey: `generate_scene:${scene.id}:${contract.id}:rewrite:${Date.now()}`,
          });
          if (!job) {
            return err(
              400,
              "bad_request",
              "プロバイダーのAPIキーが未登録です。キー設定から登録してください",
            );
          }
          return json({ job: publicJob(job) }, 202);
        }

        // POST /api/scenes/:id/revisions — 手編集リビジョンの保存
        const sceneRevs = pathname.match(
          /^\/api\/scenes\/([^/]+)\/revisions$/,
        );
        if (method === "POST" && sceneRevs) {
          const body = await parseBody(request, CreateRevisionRequestSchema);
          if (body instanceof Response) return body;
          const scene = await getSceneById(db, sceneRevs[1]!);
          if (!scene) return err(404, "not_found", "見つかりません");
          const episode = await getEpisodeById(db, scene.episode_id);
          if (!episode) return err(404, "not_found", "見つかりません");
          const work = await getWorkById(db, episode.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          // 手編集 = kind="manual_edit" の変更セットを自動生成し、
          // このリビジョンに紐付ける (spec §5.5)
          const manualChangeSet = await createChangeSet(db, {
            workId: work.id,
            kind: "manual_edit",
            title: `本文の手編集: ${scene.title}`,
            description: "作者による本文の手編集",
            ops: [],
            status: "applied",
            baseRev: work.canon_rev,
            impact: manualEditImpact({
              sceneId: scene.id,
              sceneTitle: scene.title,
            }),
            decidedAt: Date.now(),
            appliedAt: Date.now(),
          });
          const revision = await createSceneRevision(db, {
            sceneId: scene.id,
            contentJson: {
              type: "doc",
              content: body.text
                .replace(/\r\n?/g, "\n")
                .split(/\n+/)
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
                .map((t) => ({
                  type: "paragraph",
                  content: [{ type: "text", text: t }],
                })),
            },
            source: "manual_edit",
            changeSetId: manualChangeSet.id,
          });
          // 手編集のバックグラウンドレビューを起票 (spec §5.5)
          await enqueueReviewChange({
            work,
            changeSetId: manualChangeSet.id,
          });
          return json({ revision, change_set: manualChangeSet }, 201);
        }

        /**
         * POST /api/works/:id/episodes/:epId/releases — 話を不変スナップショット
         * として公開する (owner のみ)。rev_no = その話の通し番号。
         */
        const releaseCreate = pathname.match(
          /^\/api\/works\/([^/]+)\/episodes\/([^/]+)\/releases$/,
        );
        if (method === "POST" && releaseCreate) {
          const work = await getWorkById(db, releaseCreate[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const episode = await getEpisodeById(db, releaseCreate[2]!);
          if (!episode || episode.work_id !== work.id) {
            return err(404, "not_found", "見つかりません");
          }
          const content = await snapshotEpisodeProse(db, episode.id);
          if (content.length === 0) {
            return err(
              400,
              "bad_request",
              "この話にはまだ本文がありません。本文を生成してから公開してください",
            );
          }
          const release = await createRelease(db, {
            workId: work.id,
            episodeId: episode.id,
            title: episode.title,
            canonRev: work.canon_rev,
            content,
          });
          return json({ release }, 201);
        }

        /**
         * GET /api/works/:id/releases — 公開タブのデータ一式 (owner のみ)。
         * 話ごとのリリース履歴 + 公開可否 (本文の有無) + 最新公開以降の変更検出。
         */
        const workReleases = pathname.match(
          /^\/api\/works\/([^/]+)\/releases$/,
        );
        if (method === "GET" && workReleases) {
          const work = await getWorkById(db, workReleases[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const [episodes, releases] = await Promise.all([
            listEpisodesByWork(db, work.id),
            listReleasesByWork(db, work.id),
          ]);
          const latestByEpisode = new Map<string, (typeof releases)[number]>();
          for (const r of releases) latestByEpisode.set(r.episode_id, r);
          const episodeRows = [];
          for (const ep of episodes) {
            const snapshot = await snapshotEpisodeProse(db, ep.id);
            const latest = latestByEpisode.get(ep.id);
            const dirty =
              latest !== undefined &&
              (latest.title !== ep.title ||
                JSON.stringify(latest.content) !== JSON.stringify(snapshot));
            episodeRows.push({
              id: ep.id,
              ord: ep.ord,
              title: ep.title,
              has_prose: snapshot.length > 0,
              dirty,
            });
          }
          return json({ episodes: episodeRows, releases });
        }

        // POST /api/releases/:id/unlist — 公開取り下げ (owner のみ、冪等)
        const releaseUnlist = pathname.match(
          /^\/api\/releases\/([^/]+)\/unlist$/,
        );
        if (method === "POST" && releaseUnlist) {
          const release = await getReleaseById(db, releaseUnlist[1]!);
          if (!release) return err(404, "not_found", "見つかりません");
          const work = await getWorkById(db, release.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const updated =
            release.status === "unlisted"
              ? release
              : await setReleaseStatus(db, {
                  id: release.id,
                  status: "unlisted",
                });
          return json({ release: updated });
        }

        // GET /api/works/:id/changes — 変更タブ用の変更セット+findings
        const workChanges = pathname.match(
          /^\/api\/works\/([^/]+)\/changes$/,
        );
        if (method === "GET" && workChanges) {
          const work = await getWorkById(db, workChanges[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const changeSets = await listChangeSetsByWork(db, work.id);
          return json({ change_sets: changeSets });
        }

        // POST /api/change-sets/:id/(approve|reject) — 変更セットの決定
        // approve は {force:true} で force_override 昇格 (却下済みも強制可)。
        const csAction = pathname.match(
          /^\/api\/change-sets\/([^/]+)\/(approve|reject)$/,
        );
        if (method === "POST" && csAction) {
          const [, changeSetId, action] = csAction as unknown as [
            string,
            string,
            string,
          ];
          const cs = await getChangeSetById(db, changeSetId);
          if (!cs) return err(404, "not_found", "見つかりません");
          const work = await getWorkById(db, cs.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const thread = await getThreadByWorkId(db, work.id);

          if (action === "reject") {
            if (cs.status !== "proposed") {
              return err(
                400,
                "bad_request",
                "この変更セットはすでに決定済みです",
              );
            }
            const updated = await updateChangeSetState(db, {
              id: cs.id,
              status: "rejected",
              decidedAt: Date.now(),
            });
            if (thread) {
              await appendMessage(db, {
                threadId: thread.id,
                role: "assistant",
                content:
                  `変更セット「${cs.title}」を却下しました。` +
                  "どこを変えますか? 対話で指示をもらえれば、提案を修正できます。",
              });
            }
            const withFindings = await getChangeSetWithFindings(db, cs.id);
            return json({ change_set: withFindings ?? updated });
          }

          // approve (body は省略可。{force:true} で強制適用。
          // 強制適用は spec §5.4 に従い理由の記録を必須にする)
          let force = false;
          let reason: string | undefined;
          const rawBody = await request.text();
          if (rawBody.trim().length > 0) {
            const parsed = ApproveChangeSetRequestSchema.safeParse(
              JSON.parse(rawBody),
            );
            if (!parsed.success) {
              return err(400, "bad_request", "リクエストの内容が不正です");
            }
            force = parsed.data.force === true;
            reason = parsed.data.reason;
          }
          if (force && !reason) {
            return err(
              400,
              "bad_request",
              "強制適用には変更理由の記録が必要です",
            );
          }
          if (cs.status === "applied") {
            // 冪等: 適用済みは現状を返す
            const withFindings = await getChangeSetWithFindings(db, cs.id);
            return json({ change_set: withFindings, job: null });
          }
          if (cs.status === "rejected" && !force) {
            return err(
              400,
              "bad_request",
              "却下済みの変更セットです。適用するには「強制的に変更」を使ってください",
            );
          }
          if (cs.status !== "proposed" && cs.status !== "rejected") {
            return err(
              400,
              "bad_request",
              "この変更セットはすでに決定済みです",
            );
          }

          // 適用前検証 (spec §5.3 step 6-8): 通常承認の直前に同期検査を
          // 実行し、違反があれば適用せず保留にする (force 適用は §5.4 の
          // エスケープハッチとしてこの検査を迂回する)。警告だけなら適用し、
          // 結果は応答と change_sets.pre_apply_check の両方に残す。
          let preApplyCheck: PreApplyCheck | null = null;
          if (!force) {
            preApplyCheck = await verifyChangeSetForApply(db, {
              changeSetId: cs.id,
            });
            if (preApplyCheck && preApplyCheck.violations.length > 0) {
              const detail = preApplyCheck.violations
                .map((v) => `・${v.detail}`)
                .join("\n");
              return json(
                {
                  error: {
                    code: "conflict",
                    message:
                      `適用前の検査で ${preApplyCheck.violations.length} 件の問題が見つかったため、承認を保留しました。\n` +
                      `${detail}\n` +
                      (preApplyCheck.warnings.length > 0
                        ? `あわせて警告 ${preApplyCheck.warnings.length} 件が「変更」タブに記録されています。`
                        : "") +
                      "提案を修正するか、「強制的に変更」で適用してください。",
                  },
                  pre_apply_check: preApplyCheck,
                },
                409,
              );
            }
          }

          const applied = await applyChangeSet(db, {
            changeSetId: cs.id,
            force,
            reason,
          });
          if (!applied) {
            return err(500, "internal", "変更セットの適用に失敗しました");
          }
          // レビュー処理 review_change を自動起票 (キー未登録なら起票なし)
          const job = await enqueueReviewChange({
            work,
            changeSetId: cs.id,
          });
          if (thread) {
            const forceNote = force ? " (強制適用)" : "";
            await appendMessage(db, {
              threadId: thread.id,
              role: "assistant",
              content:
                `変更セット「${cs.title}」を適用しました${forceNote}。` +
                (force ? `理由: ${reason}。` : "") +
                `正典リビジョンは rev${applied.newCanonRev} です。` +
                (preApplyCheck && preApplyCheck.warnings.length > 0
                  ? `\n適用前検査で警告 ${preApplyCheck.warnings.length} 件:\n` +
                    preApplyCheck.warnings
                      .map((w) => `・${w.detail}`)
                      .join("\n") +
                    "\n"
                  : "") +
                (job
                  ? "影響するシーンのレビューを開始します。"
                  : "APIキー未登録のためレビューは起票されませんでした。"),
            });
          }
          return json({
            change_set: applied.changeSet,
            job: job ? publicJob(job) : null,
            pre_apply_check: preApplyCheck,
          });
        }

        // POST /api/review-findings/:id/status — findings の open/dismissed 切替
        const findingStatus = pathname.match(
          /^\/api\/review-findings\/([^/]+)\/status$/,
        );
        if (method === "POST" && findingStatus) {
          const body = await parseBody(request, SetFindingStatusRequestSchema);
          if (body instanceof Response) return body;
          const finding = await getReviewFindingById(db, findingStatus[1]!);
          if (!finding) return err(404, "not_found", "見つかりません");
          const cs = await getChangeSetById(db, finding.change_set_id);
          if (!cs) return err(404, "not_found", "見つかりません");
          const work = await getWorkById(db, cs.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "見つかりません");
          }
          const updated = await setReviewFindingStatus(db, {
            id: finding.id,
            status: body.status,
          });
          return json({ finding: updated });
        }

        return err(404, "not_found", "見つかりません");
      }

      // -------------------------------------------------------------------
      // 以降はすべて実行体認証 (EXECUTOR_TOKEN)
      // -------------------------------------------------------------------
      if (!(await authorizedExecutor(request))) {
        return err(401, "unauthorized", "実行体トークンが不正です");
      }

      // POST /api/jobs — ジョブ作成 (冪等)
      if (method === "POST" && pathname === "/api/jobs") {
        const body = await parseBody(request, CreateJobRequestSchema);
        if (body instanceof Response) return body;
        const { job, created } = await createJob(db, {
          kind: body.kind,
          workRef: body.work_ref ?? null,
          userRef: body.user_ref ?? null,
          payload: body.payload,
          idempotencyKey: body.idempotency_key,
        });
        return json({ job: publicJob(job), created }, created ? 201 : 200);
      }

      // POST /api/jobs/lease — queued を 1 件リース (期限切れは再取得可)
      if (method === "POST" && pathname === "/api/jobs/lease") {
        const body = await parseBody(request, LeaseRequestSchema);
        if (body instanceof Response) return body;
        const lease = await leaseNextJob(db, {
          executorId: body.executor_id,
          ...(body.lease_ttl_ms !== undefined
            ? { leaseTtlMs: body.lease_ttl_ms }
            : {}),
        });
        if (!lease) return json({ job: null });
        return json({
          job: publicJob(lease.job),
          lease_token: lease.leaseToken,
          lease_expires_at: lease.job.lease_expires_at,
        });
      }

      // GET /api/jobs/:id — 状態照会
      const jobGet = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (method === "GET" && jobGet) {
        const job = await getJob(db, jobGet[1]!);
        if (!job) return err(404, "not_found", "ジョブが見つかりません");
        return json({ job: publicJob(job) });
      }

      // POST /api/jobs/:id/(progress|heartbeat|complete|fail|steps)
      const jobAction = pathname.match(
        /^\/api\/jobs\/([^/]+)\/(progress|heartbeat|complete|fail|steps)$/,
      );
      if (method === "POST" && jobAction) {
        const [, jobId, action] = jobAction as unknown as [
          string,
          string,
          string,
        ];
        if (action === "progress") {
          const body = await parseBody(request, ProgressRequestSchema);
          if (body instanceof Response) return body;
          const event = await appendProgress(db, {
            jobId: jobId,
            leaseToken: body.lease_token,
            type: body.type,
            data: body.data,
          });
          return json({ event });
        }
        if (action === "heartbeat") {
          const body = await parseBody(request, HeartbeatRequestSchema);
          if (body instanceof Response) return body;
          const job = await heartbeat(db, {
            jobId: jobId,
            leaseToken: body.lease_token,
            ...(body.lease_ttl_ms !== undefined
              ? { leaseTtlMs: body.lease_ttl_ms }
              : {}),
            ...(body.checkpoint !== undefined
              ? { checkpoint: body.checkpoint }
              : {}),
          });
          return json({ job: publicJob(job) });
        }
        if (action === "steps") {
          const body = await parseBody(request, RecordStepRequestSchema);
          if (body instanceof Response) return body;
          const step = await insertAgentStep(db, {
            jobId: jobId,
            leaseToken: body.lease_token,
            name: body.name,
            status: body.status,
            startedAt: body.started_at,
            ...(body.ended_at !== undefined
              ? { endedAt: body.ended_at }
              : {}),
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.provider !== undefined
              ? { provider: body.provider }
              : {}),
            ...(body.usage !== undefined ? { usage: body.usage } : {}),
            ...(body.artifact !== undefined
              ? { artifact: body.artifact }
              : {}),
            ...(body.error !== undefined ? { error: body.error } : {}),
          });
          return json({ step });
        }
        if (action === "complete") {
          const body = await parseBody(request, CompleteRequestSchema);
          if (body instanceof Response) return body;
          const job = await completeJob(db, {
            jobId: jobId,
            leaseToken: body.lease_token,
            result: body.result,
          });
          // 自律運転の継続判定 (spec §7.2)。失敗しても完了応答は返す。
          try {
            await maybeContinueAutonomy(job);
          } catch (e) {
            console.error("autonomy continuation failed:", e);
          }
          return json({ job: publicJob(job) });
        }
        const body = await parseBody(request, FailRequestSchema);
        if (body instanceof Response) return body;
        const job = await failJob(db, {
          jobId: jobId,
          leaseToken: body.lease_token,
          error: body.error,
        });
        // 自律往復の失敗は自律運転を止める (spec §7.3 障害時の安全停止)。
        if (job.payload.autonomous === true && job.work_ref) {
          try {
            const work = await getWorkById(db, job.work_ref);
            if (work && work.autonomy_level === "draft") {
              await stopAutonomy(work, `ジョブが失敗しました: ${body.error.slice(0, 120)}`);
            }
          } catch (e) {
            console.error("autonomy stop on failure failed:", e);
          }
        }
        return json({ job: publicJob(job) });
      }

      // POST /api/internal/keys — BYO キー登録 (平文は受け取り暗号化して保存)
      if (method === "POST" && pathname === "/api/internal/keys") {
        const body = await parseBody(request, CreateKeyRequestSchema);
        if (body instanceof Response) return body;
        const ciphertext = await encrypt(body.api_key, secretKey);
        const key = await createKey(db, {
          ownerRef: body.owner_ref,
          label: body.label,
          ...(body.provider !== undefined
            ? { provider: body.provider }
            : {}),
          ...(body.base_url !== undefined ? { baseUrl: body.base_url } : {}),
          ciphertext,
        });
        const { ciphertext: _drop, ...pub } = key;
        return json({ key: pub }, 201);
      }

      /**
       * POST /api/internal/keys/:ref/resolve — 実行体のキー解決。
       * ジョブを起こしたユーザー (job.user_ref) とキーの owner が一致する
       * 場合だけ復号済み平文を返す (spec §9: 利用者の認可境界)。
       */
      const keyResolve = pathname.match(
        /^\/api\/internal\/keys\/([^/]+)\/resolve$/,
      );
      if (method === "POST" && keyResolve) {
        const body = await parseBody(request, ResolveKeyRequestSchema);
        if (body instanceof Response) return body;
        const key = await getKeyById(db, keyResolve[1]!);
        if (!key) return err(404, "not_found", "キーが見つかりません");
        const job = await getJob(db, body.job_id);
        if (!job) return err(404, "not_found", "ジョブが見つかりません");
        if (job.user_ref === null || key.owner_ref !== job.user_ref) {
          return err(403, "forbidden", "キーの所有者がジョブのユーザーと一致しません");
        }
        const apiKey = await decrypt(key.ciphertext, secretKey);
        return json({ api_key: apiKey, base_url: key.base_url });
      }

      // GET /api/internal/threads/:id/context — orchestrator の入力材料
      const threadCtxPath = pathname.match(
        /^\/api\/internal\/threads\/([^/]+)\/context$/,
      );
      if (method === "GET" && threadCtxPath) {
        const thread = await getThreadById(db, threadCtxPath[1]!);
        if (!thread) return err(404, "not_found", "対話スレッドが見つかりません");
        const work = await getWorkById(db, thread.work_id);
        if (!work) return err(404, "not_found", "作品が見つかりません");
        const messages = await listMessages(db, thread.id);
        const canonFacts = await listCanonFactsByWork(db, work.id);
        const entities = await listEntitiesWithAliasesByWork(db, work.id);
        const proposals = await listProposalsByWork(db, work.id);
        // workspace のファイル一覧+計画ツリー (orchestrator/planner の材料)
        const workspaceFiles = await listWorkspaceFiles(db, work);
        const planTree = await buildPlanTree(db, work.id);
        return json({
          work,
          thread,
          messages,
          canon_facts: canonFacts,
          entities,
          proposals,
          workspace_files: workspaceFiles,
          plan_tree: planTree,
        });
      }

      // POST /api/internal/threads/:id/messages — assistant メッセージ永続化
      const threadMsgPath = pathname.match(
        /^\/api\/internal\/threads\/([^/]+)\/messages$/,
      );
      if (method === "POST" && threadMsgPath) {
        const body = await parseBody(request, AppendMessageRequestSchema);
        if (body instanceof Response) return body;
        const thread = await getThreadById(db, threadMsgPath[1]!);
        if (!thread) return err(404, "not_found", "対話スレッドが見つかりません");
        const message = await appendMessage(db, {
          threadId: thread.id,
          role: body.role,
          content: body.content,
          jobId: body.job_id,
        });
        return json({ message });
      }

      // POST /api/internal/works/:id/patch — WORK_PATCH の適用
      const workPatchPath = pathname.match(
        /^\/api\/internal\/works\/([^/]+)\/patch$/,
      );
      if (method === "POST" && workPatchPath) {
        const body = await parseBody(request, WorkPatchRequestSchema);
        if (body instanceof Response) return body;
        const work = await patchWork(db, {
          id: workPatchPath[1]!,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.premise !== undefined ? { premise: body.premise } : {}),
          ...(body.genre !== undefined ? { genre: body.genre } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.charter !== undefined ? { charter: body.charter } : {}),
          ...(body.policy !== undefined ? { policy: body.policy } : {}),
        });
        if (!work) return err(404, "not_found", "作品が見つかりません");
        return json({ work });
      }

      // POST /api/internal/proposals — 提案の実体化。
      // kind="writing_contract" は episode/scene/contract もまとめて作り
      // 決定に必要な ID を payload に入れる。それ以外の kind (plan /
      // workspace_write) は payload をそのまま記録する (message_id+kind で冪等)。
      if (method === "POST" && pathname === "/api/internal/proposals") {
        const body = await parseBody(request, CreateProposalRequestSchema);
        if (body instanceof Response) return body;
        const work = await getWorkById(db, body.work_id);
        if (!work) return err(404, "not_found", "作品が見つかりません");

        if (body.kind !== PROPOSAL_KIND_WRITING_CONTRACT) {
          // plan / workspace_write 等: 実体化せず提案のみ記録
          const proposal = await createProposal(db, {
            workId: work.id,
            threadId: body.thread_id,
            messageId: body.message_id,
            kind: body.kind,
            payload: body.payload,
          });
          return json({ proposal });
        }

        const p = body.payload as {
          episode_title?: string;
          scene_title?: string;
          scene_purpose?: string;
          contract?: unknown;
        };
        if (!p.scene_title || !p.contract) {
          return err(400, "bad_request", "提案内容が不完全です");
        }
        let episode = p.episode_title
          ? await findEpisodeByTitle(db, work.id, p.episode_title)
          : await getLatestEpisode(db, work.id);
        if (!episode) {
          episode = await createEpisode(db, {
            workId: work.id,
            title: p.episode_title ?? "第1話",
          });
        }
        const scene = await createScene(db, {
          episodeId: episode.id,
          title: p.scene_title,
          purpose: p.scene_purpose ?? "",
          status: "proposed",
        });
        const contract = await createWritingContract(db, {
          sceneId: scene.id,
          status: "draft",
          payload: p.contract,
        });
        const proposal = await createProposal(db, {
          workId: work.id,
          threadId: body.thread_id,
          messageId: body.message_id,
          kind: body.kind,
          payload: {
            ...p,
            episode_id: episode.id,
            scene_id: scene.id,
            contract_id: contract.id,
          },
        });
        return json({ proposal });
      }

      // POST /api/internal/works/:id/canon-facts — CANON_FACTS の蓄積
      const canonPath = pathname.match(
        /^\/api\/internal\/works\/([^/]+)\/canon-facts$/,
      );
      if (method === "POST" && canonPath) {
        const body = await parseBody(request, AddCanonFactsRequestSchema);
        if (body instanceof Response) return body;
        const work = await getWorkById(db, canonPath[1]!);
        if (!work) return err(404, "not_found", "作品が見つかりません");
        const { canonFacts, added } = await repoAddCanonFacts(db, {
          workId: work.id,
          statements: body.statements,
          provenance: body.provenance,
        });
        return json({ canon_facts: canonFacts, added });
      }

      // GET /api/internal/scenes/:id/context — generate_scene の入力材料
      const sceneCtxPath = pathname.match(
        /^\/api\/internal\/scenes\/([^/]+)\/context$/,
      );
      if (method === "GET" && sceneCtxPath) {
        const scene = await getSceneById(db, sceneCtxPath[1]!);
        if (!scene) return err(404, "not_found", "シーンが見つかりません");
        const episode = await getEpisodeById(db, scene.episode_id);
        if (!episode) return err(404, "not_found", "話が見つかりません");
        const work = await getWorkById(db, episode.work_id);
        if (!work) return err(404, "not_found", "作品が見つかりません");
        const contract = await getLatestContractByScene(db, scene.id);
        const canonFacts = await listCanonFactsByWork(db, work.id);
        // 同じ作品内で自分より前のシーンの抜粋 (最新リビジョンの先頭200字)
        const allScenes = await listScenesByWork(db, work.id);
        const myIndex = allScenes.findIndex((sc) => sc.id === scene.id);
        const prevScenes = [];
        for (const prev of allScenes.slice(0, Math.max(0, myIndex)).slice(-3)) {
          const revs = await listRevisionsByScene(db, prev.id);
          const latest = revs.at(-1);
          prevScenes.push({
            id: prev.id,
            title: prev.title,
            excerpt: latest
              ? tiptapDocToText(latest.content_json).slice(0, 200)
              : "",
          });
        }
        const entities = await listEntitiesWithAliasesByWork(db, work.id);
        const knowledgeEvents = await listKnowledgeEventsByWork(db, work.id);
        return json({
          scene,
          contract,
          work,
          canon_facts: canonFacts,
          prev_scenes: prevScenes,
          entities,
          knowledge_events: knowledgeEvents,
        });
      }

      // POST /api/internal/scenes/:id/dependencies — writer の依存宣言の記録
      const depsPath = pathname.match(
        /^\/api\/internal\/scenes\/([^/]+)\/dependencies$/,
      );
      if (method === "POST" && depsPath) {
        const body = await parseBody(request, RecordDependenciesRequestSchema);
        if (body instanceof Response) return body;
        const scene = await getSceneById(db, depsPath[1]!);
        if (!scene) return err(404, "not_found", "シーンが見つかりません");
        const episode = await getEpisodeById(db, scene.episode_id);
        if (!episode) return err(404, "not_found", "話が見つかりません");
        const { edges, added } = await addDependencyEdges(db, {
          workId: episode.work_id,
          sceneId: scene.id,
          edges: body.edges,
        });
        return json({ edges, added });
      }

      // POST /api/internal/works/:id/workspace/write — エージェントの書き込み提案
      // (常に proposal 化。直接確定しない)
      const wsWritePath = pathname.match(
        /^\/api\/internal\/works\/([^/]+)\/workspace\/write$/,
      );
      if (method === "POST" && wsWritePath) {
        const body = await parseBody(request, WorkspaceWriteRequestSchema);
        if (body instanceof Response) return body;
        const work = await getWorkById(db, wsWritePath[1]!);
        if (!work) return err(404, "not_found", "作品が見つかりません");
        const { proposal, supported } = await workspaceWritePropose(db, {
          workId: work.id,
          path: body.path,
          content: body.content,
          provenance: body.provenance,
        });
        return json({ proposal, supported });
      }

      // POST /api/internal/scenes/:id/revisions — 生成成果の確定
      const sceneRevPath = pathname.match(
        /^\/api\/internal\/scenes\/([^/]+)\/revisions$/,
      );
      if (method === "POST" && sceneRevPath) {
        const body = await parseBody(request, PersistRevisionRequestSchema);
        if (body instanceof Response) return body;
        const scene = await getSceneById(db, sceneRevPath[1]!);
        if (!scene) return err(404, "not_found", "シーンが見つかりません");
        const revision = await createSceneRevision(db, {
          sceneId: scene.id,
          contentJson: body.content_json,
          source: body.source,
          jobId: body.job_id,
        });
        if (scene.status !== "generated") {
          await updateSceneStatus(db, { id: scene.id, status: "generated" });
        }
        return json({ revision });
      }

      // POST /api/internal/works/:id/change-sets — <<CHANGESET>> の提案作成。
      // 影響分析はここで決定的に計算して impact に保存し、status=proposed で
      // 返す (message_id つきはユニーク制約で冪等)。
      const internalCsPath = pathname.match(
        /^\/api\/internal\/works\/([^/]+)\/change-sets$/,
      );
      if (method === "POST" && internalCsPath) {
        const body = await parseBody(request, CreateChangeSetRequestSchema);
        if (body instanceof Response) return body;
        const work = await getWorkById(db, internalCsPath[1]!);
        if (!work) return err(404, "not_found", "作品が見つかりません");
        const impact = await computeChangeSetImpact(db, {
          workId: work.id,
          ops: body.ops,
        });
        const cs = await createChangeSet(db, {
          workId: work.id,
          kind: body.kind,
          title: body.title,
          description: body.description,
          ops: body.ops,
          impact,
          baseRev: work.canon_rev,
          messageId: body.message_id ?? null,
        });
        const withFindings = await getChangeSetWithFindings(db, cs.id);
        return json({ change_set: withFindings ?? cs }, 201);
      }

      // GET /api/internal/change-sets/:id/context — review_change の入力材料
      const csCtxPath = pathname.match(
        /^\/api\/internal\/change-sets\/([^/]+)\/context$/,
      );
      if (method === "GET" && csCtxPath) {
        const cs = await getChangeSetWithFindings(db, csCtxPath[1]!);
        if (!cs) return err(404, "not_found", "見つかりません");
        const work = await getWorkById(db, cs.work_id);
        if (!work) return err(404, "not_found", "作品が見つかりません");
        const thread = await getThreadByWorkId(db, work.id);
        if (!thread) return err(404, "not_found", "対話スレッドが見つかりません");
        const canonFacts = await listCanonFactsByWork(db, work.id);
        const scenes = [];
        for (const s of cs.impact.scenes) {
          const scene = await getSceneById(db, s.id);
          if (!scene) continue;
          const revs = await listRevisionsByScene(db, scene.id);
          const latest = revs.at(-1);
          const contract = await getLatestContractByScene(db, scene.id);
          scenes.push({
            id: scene.id,
            title: scene.title,
            prose_md: latest ? tiptapDocToText(latest.content_json) : "",
            contract: contract ? contract.payload : null,
          });
        }
        return json({
          change_set: cs,
          work,
          thread_id: thread.id,
          canon_facts: canonFacts,
          scenes,
        });
      }

      // POST /api/internal/change-sets/:id/findings — review_change の記録
      const csFindingsPath = pathname.match(
        /^\/api\/internal\/change-sets\/([^/]+)\/findings$/,
      );
      if (method === "POST" && csFindingsPath) {
        const body = await parseBody(
          request,
          RecordReviewFindingsRequestSchema,
        );
        if (body instanceof Response) return body;
        const cs = await getChangeSetById(db, csFindingsPath[1]!);
        if (!cs) return err(404, "not_found", "見つかりません");
        const { findings, added } = await addReviewFindings(db, {
          changeSetId: cs.id,
          findings: body.findings.map((f) => ({
            kind: f.kind,
            severity: f.severity,
            summary: f.summary,
            detail: f.detail,
            sceneId: f.scene_id ?? null,
            factId: f.fact_id ?? null,
          })),
        });
        return json({ findings, added });
      }

      return err(404, "not_found", "見つかりません");
    } catch (e) {
      return repoError(e);
    }
  };
}
