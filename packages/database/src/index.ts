import { sql, type SQLWrapper } from "drizzle-orm";
import {
  AgentJobSchema,
  JobStatusSchema,
  ProgressEventSchema,
  ProviderKeySchema,
  type AgentJob,
  type JobStatus,
  type ProgressEvent,
  type ProgressEventType,
  type ProviderKey,
} from "@houchi/contracts";

export * from "./schema.js";

/**
 * packages/database — D1 (Drizzle) 向けスキーマ + リポジトリ関数群。
 * better-sqlite3 (ローカル/テスト, 同期) と D1 (非同期) の両方で動くよう、
 * drizzle の `db.get/all/run(sql`...`)` 共通面のみを使い結果を await する。
 */

/** better-sqlite3 / D1 両ドライバを受ける最小構造。戻り値は await 前提。 */
export interface DbLike {
  get(query: SQLWrapper): unknown;
  all(query: SQLWrapper): unknown;
  run(query: SQLWrapper): unknown;
}

export class RepoError extends Error {
  override name = "RepoError";
  constructor(
    public readonly code: "not_found" | "lease_conflict" | "internal",
    message: string,
  ) {
    super(message);
  }
}

const now = () => Date.now();

// ---------------------------------------------------------------------------
// row <-> contract
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function rowToJob(r: Row): AgentJob {
  return AgentJobSchema.parse({
    id: r.id,
    kind: r.kind,
    work_ref: r.work_ref ?? null,
    payload: JSON.parse(String(r.payload)),
    idempotency_key: r.idempotency_key,
    status: JobStatusSchema.parse(r.status),
    leased_by: r.leased_by ?? null,
    lease_token: r.lease_token ?? null,
    lease_expires_at: r.lease_expires_at ?? null,
    attempts: r.attempts,
    result: r.result == null ? null : JSON.parse(String(r.result)),
    error: r.error ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

function rowToEvent(r: Row): ProgressEvent {
  return ProgressEventSchema.parse({
    id: r.id,
    job_id: r.job_id,
    seq: r.seq,
    type: r.type,
    data: JSON.parse(String(r.data)),
    created_at: r.created_at,
  });
}

function rowToKey(r: Row): ProviderKey {
  return ProviderKeySchema.parse({
    id: r.id,
    owner_ref: r.owner_ref,
    label: r.label,
    ciphertext: r.ciphertext,
    created_at: r.created_at,
  });
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

export async function createJob(
  db: DbLike,
  input: {
    kind: string;
    workRef?: string | null;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<{ job: AgentJob; created: boolean }> {
  const id = crypto.randomUUID();
  const t = now();
  const rows = (await db.all(sql`
    INSERT INTO agent_jobs
      (id, kind, work_ref, payload, idempotency_key, status, attempts, created_at, updated_at)
    VALUES
      (${id}, ${input.kind}, ${input.workRef ?? null},
       ${JSON.stringify(input.payload)}, ${input.idempotencyKey},
       'queued', 0, ${t}, ${t})
    ON CONFLICT(idempotency_key) DO NOTHING
    RETURNING *
  `)) as Row[];
  if (rows.length > 0) {
    return { job: rowToJob(rows[0]!), created: true };
  }
  const existing = await getJobByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) throw new RepoError("internal", "insert failed");
  return { job: existing, created: false };
}

export async function getJob(db: DbLike, id: string): Promise<AgentJob | null> {
  const r = (await db.get(
    sql`SELECT * FROM agent_jobs WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToJob(r) : null;
}

export async function getJobByIdempotencyKey(
  db: DbLike,
  key: string,
): Promise<AgentJob | null> {
  const r = (await db.get(
    sql`SELECT * FROM agent_jobs WHERE idempotency_key = ${key}`,
  )) as Row | undefined;
  return r ? rowToJob(r) : null;
}

export const DEFAULT_LEASE_TTL_MS = 60_000;

/**
 * queued → leased の原子的遷移 (単一 UPDATE)。
 * - 期限切れの leased ジョブは再リース可能 (spec §7.5)。
 * - 有効なリースを持つ work_ref と同じ work_ref のジョブはリースしない
 *   (同一作品の直列化, spec §7.5)。
 */
export async function leaseNextJob(
  db: DbLike,
  input: { executorId: string; leaseTtlMs?: number },
): Promise<{ job: AgentJob; leaseToken: string } | null> {
  const t = now();
  const ttl = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const leaseToken = crypto.randomUUID();
  const expires = t + ttl;
  const rows = (await db.all(sql`
    UPDATE agent_jobs SET
      status = 'leased',
      leased_by = ${input.executorId},
      lease_token = ${leaseToken},
      lease_expires_at = ${expires},
      attempts = attempts + 1,
      updated_at = ${t}
    WHERE id = (
      SELECT id FROM agent_jobs
      WHERE (status = 'queued' OR (status = 'leased' AND lease_expires_at <= ${t}))
        AND (work_ref IS NULL OR work_ref NOT IN (
          SELECT work_ref FROM agent_jobs
          WHERE status = 'leased' AND lease_expires_at > ${t} AND work_ref IS NOT NULL
        ))
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING *
  `)) as Row[];
  if (rows.length === 0) return null;
  return { job: rowToJob(rows[0]!), leaseToken };
}

/** リース保持者チェック。違反は lease_conflict、ジョブ不在は not_found。 */
function assertLease(job: AgentJob | null, leaseToken: string): AgentJob {
  if (!job) throw new RepoError("not_found", "job not found");
  if (job.status !== "leased" || job.lease_token !== leaseToken) {
    throw new RepoError("lease_conflict", "lease token mismatch");
  }
  if (job.lease_expires_at != null && job.lease_expires_at <= now()) {
    throw new RepoError("lease_conflict", "lease expired");
  }
  return job;
}

export async function appendProgress(
  db: DbLike,
  input: {
    jobId: string;
    leaseToken: string;
    type: ProgressEventType;
    data: unknown;
  },
): Promise<ProgressEvent> {
  assertLease(await getJob(db, input.jobId), input.leaseToken);
  const id = crypto.randomUUID();
  const t = now();
  const rows = (await db.all(sql`
    INSERT INTO progress_events (id, job_id, seq, type, data, created_at)
    VALUES (
      ${id}, ${input.jobId},
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM progress_events WHERE job_id = ${input.jobId}),
      ${input.type}, ${JSON.stringify(input.data ?? null)}, ${t}
    )
    RETURNING *
  `)) as Row[];
  await db.run(
    sql`UPDATE agent_jobs SET updated_at = ${t} WHERE id = ${input.jobId}`,
  );
  return rowToEvent(rows[0]!);
}

/**
 * リース延長。checkpoint を渡すと payload.checkpoint へ浅いマージで保存する
 * (チェックポイント再開の永続化ポイント)。
 */
export async function heartbeat(
  db: DbLike,
  input: {
    jobId: string;
    leaseToken: string;
    leaseTtlMs?: number;
    checkpoint?: Record<string, unknown>;
  },
): Promise<AgentJob> {
  const job = assertLease(await getJob(db, input.jobId), input.leaseToken);
  const t = now();
  const expires = t + (input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
  let payload = job.payload;
  if (input.checkpoint !== undefined) {
    const prev =
      (payload.checkpoint as Record<string, unknown> | undefined) ?? {};
    payload = {
      ...payload,
      checkpoint: { ...prev, ...input.checkpoint },
    };
  }
  const rows = (await db.all(sql`
    UPDATE agent_jobs SET
      lease_expires_at = ${expires},
      payload = ${JSON.stringify(payload)},
      updated_at = ${t}
    WHERE id = ${input.jobId}
    RETURNING *
  `)) as Row[];
  return rowToJob(rows[0]!);
}

/**
 * 成果物確定と完了通知をアトミックに行う (spec §7.5)。
 * lease_token + 期限を WHERE 条件に含め、不一致なら lease_conflict。
 */
export async function completeJob(
  db: DbLike,
  input: { jobId: string; leaseToken: string; result: unknown },
): Promise<AgentJob> {
  const t = now();
  const rows = (await db.all(sql`
    UPDATE agent_jobs SET
      status = 'completed',
      result = ${JSON.stringify(input.result ?? null)},
      updated_at = ${t}
    WHERE id = ${input.jobId}
      AND status = 'leased'
      AND lease_token = ${input.leaseToken}
      AND lease_expires_at > ${t}
    RETURNING *
  `)) as Row[];
  if (rows.length === 0) {
    assertLease(await getJob(db, input.jobId), input.leaseToken);
    throw new RepoError("lease_conflict", "job is not leased");
  }
  return rowToJob(rows[0]!);
}

export async function failJob(
  db: DbLike,
  input: { jobId: string; leaseToken: string; error: string },
): Promise<AgentJob> {
  const t = now();
  const rows = (await db.all(sql`
    UPDATE agent_jobs SET
      status = 'failed',
      error = ${input.error.slice(0, 2000)},
      updated_at = ${t}
    WHERE id = ${input.jobId}
      AND status = 'leased'
      AND lease_token = ${input.leaseToken}
      AND lease_expires_at > ${t}
    RETURNING *
  `)) as Row[];
  if (rows.length === 0) {
    assertLease(await getJob(db, input.jobId), input.leaseToken);
    throw new RepoError("lease_conflict", "job is not leased");
  }
  return rowToJob(rows[0]!);
}

export async function listProgress(
  db: DbLike,
  jobId: string,
): Promise<ProgressEvent[]> {
  const rows = (await db.all(
    sql`SELECT * FROM progress_events WHERE job_id = ${jobId} ORDER BY seq ASC`,
  )) as Row[];
  return rows.map(rowToEvent);
}

// ---------------------------------------------------------------------------
// provider_keys
// ---------------------------------------------------------------------------

export async function createKey(
  db: DbLike,
  input: { ownerRef: string; label: string; ciphertext: string },
): Promise<ProviderKey> {
  const id = crypto.randomUUID();
  const rows = (await db.all(sql`
    INSERT INTO provider_keys (id, owner_ref, label, ciphertext, created_at)
    VALUES (${id}, ${input.ownerRef}, ${input.label}, ${input.ciphertext}, ${now()})
    RETURNING *
  `)) as Row[];
  return rowToKey(rows[0]!);
}

export async function getKeyById(
  db: DbLike,
  id: string,
): Promise<ProviderKey | null> {
  const r = (await db.get(
    sql`SELECT * FROM provider_keys WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToKey(r) : null;
}

export type { AgentJob, JobStatus, ProgressEvent, ProgressEventType, ProviderKey };
