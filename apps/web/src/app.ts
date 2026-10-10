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
  PROPOSAL_KIND_PLAN,
  PROPOSAL_KIND_WORKSPACE_WRITE,
  PROPOSAL_KIND_WRITING_CONTRACT,
  RecordDependenciesRequestSchema,
  RecordReviewFindingsRequestSchema,
  ResolveKeyRequestSchema,
  RewriteSceneRequestSchema,
  SetFindingStatusRequestSchema,
  tiptapDocToText,
  WorkPatchRequestSchema,
  WorkSettingsRequestSchema,
  WorkspaceWriteRequestSchema,
  type AgentJob,
  type ApiErrorCode,
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
  getProposalById,
  getReviewFindingById,
  getSceneById,
  getThreadById,
  getThreadByWorkId,
  getUserIdByEmail,
  getWorkById,
  heartbeat,
  leaseNextJob,
  listCanonFactsByWork,
  listChangeSetsByWork,
  listContractsByWork,
  listEpisodesByWork,
  listKeysByOwner,
  listMessages,
  listOpenJobsByWork,
  listProgress,
  listProposalsByWork,
  listRevisionsByScene,
  listRevisionsByWork,
  listScenesByWork,
  listWorksByOwner,
  manualEditImpact,
  patchWork,
  RepoError,
  setReviewFindingStatus,
  updateChangeSetState,
  updateContractStatus,
  updateProposalStatus,
  updateSceneStatus,
  updateWorkConfig,
  type DbLike,
} from "@houchi/database";
import { decrypt, encrypt, secretsEqual } from "@houchi/secrets";
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
    return err(400, "bad_request", "invalid JSON body");
  }
  try {
    return schema.parse(raw);
  } catch {
    return err(400, "bad_request", "request validation failed");
  }
}

/** lease_token は認証情報なので API 応答からは取り除く。 */
function publicJob(job: AgentJob): AgentJob {
  return { ...job, lease_token: null };
}

function repoError(e: unknown): Response {
  if (e instanceof RepoError) {
    const status =
      e.code === "not_found" ? 404 : e.code === "lease_conflict" ? 409 : 500;
    return err(status, e.code === "internal" ? "internal" : e.code, e.message);
  }
  return err(500, "internal", "unexpected error");
}

/** dev-login で作る固定開発ユーザーの識別子。 */
const DEV_USER_EMAIL = "dev@houchi-sakka.local";
const DEV_USER_NAME = "開発ユーザー";
const DEV_USER_PASSWORD = "dev-login-password";

export function createApp(deps: WebDeps): FetchHandler {
  const { db, secretKey, executorToken, auth } = deps;

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
        model: input.work.model ?? deps.defaultModel,
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
        model: input.work.model ?? deps.defaultModel,
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
      return err(404, "not_found", "not found");
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
      return err(500, "internal", "dev login failed");
    }
    const setCookie = inner.headers.get("set-cookie");
    if (!setCookie) {
      return err(500, "internal", "dev login did not return a session cookie");
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
            model: deps.defaultModel,
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
            return err(404, "not_found", "not found");
          }
          const thread = await getThreadByWorkId(db, work.id);
          if (!thread) return err(500, "internal", "thread missing");
          const messages = await listMessages(db, thread.id);
          const openJobs = await listOpenJobsByWork(db, work.id);
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
          });
        }

        // POST /api/works/:id/messages — 送信→orchestrator_turn をキュー
        if (method === "POST" && workMsgPath) {
          const body = await parseBody(request, CreateMessageRequestSchema);
          if (body instanceof Response) return body;
          const work = await getWorkById(db, workMsgPath[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
          }
          const thread = await getThreadByWorkId(db, work.id);
          if (!thread) return err(500, "internal", "thread missing");

          let key;
          if (body.key_id) {
            key = await getKeyById(db, body.key_id);
            if (!key || key.owner_ref !== user.id) {
              return err(400, "bad_request", "指定したキーが見つかりません");
            }
          } else {
            const keys = await listKeysByOwner(db, user.id);
            key = keys.at(-1);
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
              model: body.model ?? deps.defaultModel,
              trigger_message_id: message.id,
            },
            // 同一メッセージからの重複ジョブを抑止
            idempotencyKey: `orchestrator_turn:${message.id}`,
          });
          return json({ message, job: publicJob(job) }, 202);
        }

        // GET /api/keys — 自分のキー一覧 (ciphertext は絶対返さない)
        if (method === "GET" && pathname === "/api/keys") {
          const keys = await listKeysByOwner(db, user.id);
          return json({
            keys: keys.map(({ ciphertext: _drop, ...pub }) => pub),
          });
        }

        // POST /api/keys — キー登録 (暗号化して保存)
        if (method === "POST" && pathname === "/api/keys") {
          const body = await parseBody(request, CreateUserKeyRequestSchema);
          if (body instanceof Response) return body;
          const ciphertext = await encrypt(body.api_key, secretKey);
          const key = await createKey(db, {
            ownerRef: user.id,
            label: body.label,
            provider: body.provider,
            ciphertext,
          });
          const { ciphertext: _drop, ...pub } = key;
          return json({ key: pub }, 201);
        }

        // DELETE /api/keys/:id — 自分のキーだけ消せる
        const keyDelete = pathname.match(/^\/api\/keys\/([^/]+)$/);
        if (method === "DELETE" && keyDelete) {
          const deleted = await deleteKey(db, {
            id: keyDelete[1]!,
            ownerRef: user.id,
          });
          if (!deleted) return err(404, "not_found", "not found");
          return json({ ok: true });
        }

        // GET /api/works/:id/prose — 本文タブ用の話/シーン/リビジョン/契約/正典
        const workProse = pathname.match(/^\/api\/works\/([^/]+)\/prose$/);
        if (method === "GET" && workProse) {
          const work = await getWorkById(db, workProse[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
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
            return err(404, "not_found", "not found");
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
            return err(404, "not_found", "not found");
          }
          const filePath = url.searchParams.get("path") ?? "";
          const file = await readWorkspaceFile(db, work, filePath);
          if (!file) return err(404, "not_found", "file not found");
          return json(file);
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
            return err(404, "not_found", "not found");
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
            ...(body.model !== undefined ? { model: body.model } : {}),
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
          if (!proposal) return err(404, "not_found", "not found");
          const work = await getWorkById(db, proposal.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
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
              return err(500, "internal", "plan proposal payload is invalid");
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
              content: `正典メモに ${added} 件追加しました。`,
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
            return err(500, "internal", "proposal payload is incomplete");
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
          if (!scene) return err(404, "not_found", "not found");
          const episode = await getEpisodeById(db, scene.episode_id);
          if (!episode) return err(404, "not_found", "not found");
          const work = await getWorkById(db, episode.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
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
          if (!scene) return err(404, "not_found", "not found");
          const episode = await getEpisodeById(db, scene.episode_id);
          if (!episode) return err(404, "not_found", "not found");
          const work = await getWorkById(db, episode.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
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

        // GET /api/works/:id/changes — 変更タブ用の変更セット+findings
        const workChanges = pathname.match(
          /^\/api\/works\/([^/]+)\/changes$/,
        );
        if (method === "GET" && workChanges) {
          const work = await getWorkById(db, workChanges[1]!);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
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
          if (!cs) return err(404, "not_found", "not found");
          const work = await getWorkById(db, cs.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
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

          // approve (body は省略可。{force:true} で強制適用)
          let force = false;
          const rawBody = await request.text();
          if (rawBody.trim().length > 0) {
            const parsed = ApproveChangeSetRequestSchema.safeParse(
              JSON.parse(rawBody),
            );
            if (!parsed.success) {
              return err(400, "bad_request", "invalid request body");
            }
            force = parsed.data.force === true;
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

          const applied = await applyChangeSet(db, {
            changeSetId: cs.id,
            force,
          });
          if (!applied) {
            return err(500, "internal", "failed to apply change set");
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
                `正典リビジョンは rev${applied.newCanonRev} です。` +
                (job
                  ? "影響するシーンのレビューを開始します。"
                  : "APIキー未登録のためレビューは起票されませんでした。"),
            });
          }
          return json({
            change_set: applied.changeSet,
            job: job ? publicJob(job) : null,
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
          if (!finding) return err(404, "not_found", "not found");
          const cs = await getChangeSetById(db, finding.change_set_id);
          if (!cs) return err(404, "not_found", "not found");
          const work = await getWorkById(db, cs.work_id);
          if (!work || work.owner_ref !== user.id) {
            return err(404, "not_found", "not found");
          }
          const updated = await setReviewFindingStatus(db, {
            id: finding.id,
            status: body.status,
          });
          return json({ finding: updated });
        }

        return err(404, "not_found", "not found");
      }

      // -------------------------------------------------------------------
      // 以降はすべて実行体認証 (EXECUTOR_TOKEN)
      // -------------------------------------------------------------------
      if (!(await authorizedExecutor(request))) {
        return err(401, "unauthorized", "invalid executor token");
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
        if (!job) return err(404, "not_found", "job not found");
        return json({ job: publicJob(job) });
      }

      // POST /api/jobs/:id/(progress|heartbeat|complete|fail)
      const jobAction = pathname.match(
        /^\/api\/jobs\/([^/]+)\/(progress|heartbeat|complete|fail)$/,
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
        if (action === "complete") {
          const body = await parseBody(request, CompleteRequestSchema);
          if (body instanceof Response) return body;
          const job = await completeJob(db, {
            jobId: jobId,
            leaseToken: body.lease_token,
            result: body.result,
          });
          return json({ job: publicJob(job) });
        }
        const body = await parseBody(request, FailRequestSchema);
        if (body instanceof Response) return body;
        const job = await failJob(db, {
          jobId: jobId,
          leaseToken: body.lease_token,
          error: body.error,
        });
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
        if (!key) return err(404, "not_found", "key not found");
        const job = await getJob(db, body.job_id);
        if (!job) return err(404, "not_found", "job not found");
        if (job.user_ref === null || key.owner_ref !== job.user_ref) {
          return err(403, "forbidden", "key owner does not match job user");
        }
        const apiKey = await decrypt(key.ciphertext, secretKey);
        return json({ api_key: apiKey });
      }

      // GET /api/internal/threads/:id/context — orchestrator の入力材料
      const threadCtxPath = pathname.match(
        /^\/api\/internal\/threads\/([^/]+)\/context$/,
      );
      if (method === "GET" && threadCtxPath) {
        const thread = await getThreadById(db, threadCtxPath[1]!);
        if (!thread) return err(404, "not_found", "thread not found");
        const work = await getWorkById(db, thread.work_id);
        if (!work) return err(404, "not_found", "work not found");
        const messages = await listMessages(db, thread.id);
        const canonFacts = await listCanonFactsByWork(db, work.id);
        const proposals = await listProposalsByWork(db, work.id);
        // workspace のファイル一覧+計画ツリー (orchestrator/planner の材料)
        const workspaceFiles = await listWorkspaceFiles(db, work);
        const planTree = await buildPlanTree(db, work.id);
        return json({
          work,
          thread,
          messages,
          canon_facts: canonFacts,
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
        if (!thread) return err(404, "not_found", "thread not found");
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
        if (!work) return err(404, "not_found", "work not found");
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
        if (!work) return err(404, "not_found", "work not found");

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
          return err(400, "bad_request", "proposal payload is incomplete");
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
        if (!work) return err(404, "not_found", "work not found");
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
        if (!scene) return err(404, "not_found", "scene not found");
        const episode = await getEpisodeById(db, scene.episode_id);
        if (!episode) return err(404, "not_found", "episode not found");
        const work = await getWorkById(db, episode.work_id);
        if (!work) return err(404, "not_found", "work not found");
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
        return json({
          scene,
          contract,
          work,
          canon_facts: canonFacts,
          prev_scenes: prevScenes,
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
        if (!scene) return err(404, "not_found", "scene not found");
        const episode = await getEpisodeById(db, scene.episode_id);
        if (!episode) return err(404, "not_found", "episode not found");
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
        if (!work) return err(404, "not_found", "work not found");
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
        if (!scene) return err(404, "not_found", "scene not found");
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
        if (!work) return err(404, "not_found", "work not found");
        const impact = await computeChangeSetImpact(db, {
          workId: work.id,
          ops: body.ops,
        });
        const cs = await createChangeSet(db, {
          workId: work.id,
          title: body.title,
          description: body.description,
          ops: body.ops,
          impact,
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
        if (!cs) return err(404, "not_found", "not found");
        const work = await getWorkById(db, cs.work_id);
        if (!work) return err(404, "not_found", "work not found");
        const thread = await getThreadByWorkId(db, work.id);
        if (!thread) return err(404, "not_found", "thread not found");
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
        if (!cs) return err(404, "not_found", "not found");
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

      return err(404, "not_found", "not found");
    } catch (e) {
      return repoError(e);
    }
  };
}
