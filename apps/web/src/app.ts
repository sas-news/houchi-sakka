import {
  CompleteRequestSchema,
  CreateJobRequestSchema,
  CreateKeyRequestSchema,
  FailRequestSchema,
  HeartbeatRequestSchema,
  LeaseRequestSchema,
  ProgressRequestSchema,
  type AgentJob,
  type ApiErrorCode,
} from "@houchi/contracts";
import {
  appendProgress,
  completeJob,
  createJob,
  createKey,
  failJob,
  getJob,
  getKeyById,
  heartbeat,
  leaseNextJob,
  RepoError,
  type DbLike,
} from "@houchi/database";
import { decrypt, encrypt, secretsEqual } from "@houchi/secrets";

/**
 * apps/web — Phase 0 の最小 API Worker。
 * Studio UI / ユーザー認証は Phase 1 以降。全エンドポイントは
 * 実行体共有シークレット (EXECUTOR_TOKEN) の Bearer 認証で守る。
 */

export interface WebDeps {
  db: DbLike;
  /** APP_SECRET_KEY (base64 の 32 バイト)。 */
  secretKey: string;
  executorToken: string;
}

export type FetchHandler = (request: Request) => Promise<Response>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, code: ApiErrorCode, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function parseBody<T>(req: Request, schema: {
  parse(input: unknown): T;
}): Promise<T | Response> {
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

export function createApp(deps: WebDeps): FetchHandler {
  const { db, secretKey, executorToken } = deps;

  const authorized = async (req: Request): Promise<boolean> => {
    const h = req.headers.get("authorization");
    if (!h?.startsWith("Bearer ")) return false;
    return secretsEqual(h.slice(7).trim(), executorToken);
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    try {
      if (method === "GET" && pathname === "/api/healthz") {
        return json({ ok: true });
      }

      // 以降はすべて実行体認証 (Phase 0)。
      if (!(await authorized(request))) {
        return err(401, "unauthorized", "invalid executor token");
      }

      // POST /api/jobs — ジョブ作成 (冪等)
      if (method === "POST" && pathname === "/api/jobs") {
        const body = await parseBody(request, CreateJobRequestSchema);
        if (body instanceof Response) return body;
        const { job, created } = await createJob(db, {
          kind: body.kind,
          workRef: body.work_ref ?? null,
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
        const [, jobId, action] = jobAction as unknown as [string, string, string];
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
          ciphertext,
        });
        const { ciphertext: _drop, ...pub } = key;
        return json({ key: pub }, 201);
      }

      // GET /api/internal/keys/:ref — 実行体が復号した平文を取る (実行体認証のみ)
      const keyGet = pathname.match(/^\/api\/internal\/keys\/([^/]+)$/);
      if (method === "GET" && keyGet) {
        const key = await getKeyById(db, keyGet[1]!);
        if (!key) return err(404, "not_found", "key not found");
        const apiKey = await decrypt(key.ciphertext, secretKey);
        return json({ api_key: apiKey });
      }

      return err(404, "not_found", "not found");
    } catch (e) {
      return repoError(e);
    }
  };
}
