import {
  AppendMessageRequestSchema,
  CompleteRequestSchema,
  CreateJobRequestSchema,
  CreateKeyRequestSchema,
  CreateMessageRequestSchema,
  CreateUserKeyRequestSchema,
  CreateWorkRequestSchema,
  FailRequestSchema,
  HeartbeatRequestSchema,
  JOB_KIND_ORCHESTRATOR_TURN,
  LeaseRequestSchema,
  ProgressRequestSchema,
  ResolveKeyRequestSchema,
  WorkPatchRequestSchema,
  type AgentJob,
  type ApiErrorCode,
} from "@houchi/contracts";
import {
  appendMessage,
  appendProgress,
  completeJob,
  createJob,
  createKey,
  createWork,
  deleteKey,
  failJob,
  getJob,
  getKeyById,
  getThreadById,
  getThreadByWorkId,
  getUserIdByEmail,
  getWorkById,
  heartbeat,
  leaseNextJob,
  listKeysByOwner,
  listMessages,
  listOpenJobsByWork,
  listProgress,
  listWorksByOwner,
  patchWork,
  RepoError,
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
        pathname.startsWith("/api/keys/");
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
          const { work, thread } = await createWork(db, {
            ownerRef: user.id,
            title: body.title,
            ...(body.premise !== undefined ? { premise: body.premise } : {}),
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
          const active = openJobs[0] ?? null;
          return json({
            work,
            thread,
            messages,
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
        return json({ work, thread, messages });
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
        });
        if (!work) return err(404, "not_found", "work not found");
        return json({ work });
      }

      return err(404, "not_found", "not found");
    } catch (e) {
      return repoError(e);
    }
  };
}
