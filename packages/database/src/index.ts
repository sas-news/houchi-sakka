import { sql, type SQLWrapper } from "drizzle-orm";
import {
  AgentJobSchema,
  CanonFactSchema,
  ChangeSetSchema,
  ChangeSetWithFindingsSchema,
  ChatMessageSchema,
  ChatRoleSchema,
  ChatThreadSchema,
  DependencyEdgeSchema,
  EpisodeSchema,
  JobStatusSchema,
  ProgressEventSchema,
  ProposalSchema,
  ProviderKeySchema,
  ReviewFindingSchema,
  SceneRevisionSchema,
  SceneSchema,
  WorkSchema,
  WorkStatusSchema,
  WritingContractPayloadSchema,
  WritingContractSchema,
  type AgentJob,
  type CanonFact,
  type ChangeSet,
  type ChangeSetImpact,
  type ChangeSetOp,
  type ChangeSetWithFindings,
  type ChatMessage,
  type ChatRole,
  type ChatThread,
  type DependencyEdge,
  type DependencyEdgeInput,
  type Episode,
  type JobStatus,
  type ProgressEvent,
  type ProgressEventType,
  type Proposal,
  type ProviderKey,
  type ReviewFinding,
  type Scene,
  type SceneRevision,
  type Work,
  type WorkStatus,
  type WritingContract,
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
    user_ref: r.user_ref ?? null,
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
    provider: r.provider,
    ciphertext: r.ciphertext,
    created_at: r.created_at,
  });
}

function rowToWork(r: Row): Work {
  return WorkSchema.parse({
    id: r.id,
    owner_ref: r.owner_ref,
    title: r.title,
    premise: r.premise,
    genre: r.genre,
    status: WorkStatusSchema.parse(r.status),
    charter: r.charter_json == null ? null : JSON.parse(String(r.charter_json)),
    policy: r.policy_json == null ? null : JSON.parse(String(r.policy_json)),
    provider: r.provider ?? null,
    model: r.model ?? null,
    key_ref: r.key_ref ?? null,
    canon_rev: r.canon_rev ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

function rowToThread(r: Row): ChatThread {
  return ChatThreadSchema.parse({
    id: r.id,
    work_id: r.work_id,
    created_at: r.created_at,
  });
}

function rowToMessage(r: Row): ChatMessage {
  return ChatMessageSchema.parse({
    id: r.id,
    thread_id: r.thread_id,
    role: ChatRoleSchema.parse(r.role),
    content: r.content,
    job_id: r.job_id ?? null,
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
    userRef?: string | null;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<{ job: AgentJob; created: boolean }> {
  const id = crypto.randomUUID();
  const t = now();
  const rows = (await db.all(sql`
    INSERT INTO agent_jobs
      (id, kind, work_ref, user_ref, payload, idempotency_key, status, attempts, created_at, updated_at)
    VALUES
      (${id}, ${input.kind}, ${input.workRef ?? null}, ${input.userRef ?? null},
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

/**
 * 作品に紐づく未完了ジョブ (queued/leased) を古い順で返す。
 * 同一作品のジョブは直列化されるので先頭が「実行中/次に走る」もの。
 */
export async function listOpenJobsByWork(
  db: DbLike,
  workId: string,
): Promise<AgentJob[]> {
  const rows = (await db.all(
    sql`SELECT * FROM agent_jobs
        WHERE work_ref = ${workId} AND status IN ('queued', 'leased')
        ORDER BY created_at ASC`,
  )) as Row[];
  return rows.map(rowToJob);
}

// ---------------------------------------------------------------------------
// provider_keys
// ---------------------------------------------------------------------------

export async function createKey(
  db: DbLike,
  input: {
    ownerRef: string;
    label: string;
    provider?: string;
    ciphertext: string;
  },
): Promise<ProviderKey> {
  const id = crypto.randomUUID();
  const rows = (await db.all(sql`
    INSERT INTO provider_keys (id, owner_ref, label, provider, ciphertext, created_at)
    VALUES (${id}, ${input.ownerRef}, ${input.label},
            ${input.provider ?? "openai"}, ${input.ciphertext}, ${now()})
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

/** 自分のキー一覧。ciphertext は呼び出し側で必ず削ること。 */
export async function listKeysByOwner(
  db: DbLike,
  ownerRef: string,
): Promise<ProviderKey[]> {
  const rows = (await db.all(
    sql`SELECT * FROM provider_keys WHERE owner_ref = ${ownerRef}
        ORDER BY created_at ASC`,
  )) as Row[];
  return rows.map(rowToKey);
}

/** 所有者限定で削除。他人のキーは消せない (対象なし → false)。 */
export async function deleteKey(
  db: DbLike,
  input: { id: string; ownerRef: string },
): Promise<boolean> {
  const rows = (await db.all(sql`
    DELETE FROM provider_keys
    WHERE id = ${input.id} AND owner_ref = ${input.ownerRef}
    RETURNING id
  `)) as Row[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// works / chat_threads / chat_messages (Phase 1a)
// ---------------------------------------------------------------------------

/** 作品と1本の対話スレッドを同時に作る (MVP は作品につきスレッド1本)。 */
export async function createWork(
  db: DbLike,
  input: {
    ownerRef: string;
    title: string;
    premise?: string;
    provider?: string;
    model?: string;
    keyRef?: string;
  },
): Promise<{ work: Work; thread: ChatThread }> {
  const workId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const t = now();
  const workRows = (await db.all(sql`
    INSERT INTO works (id, owner_ref, title, premise, genre, status,
                       charter_json, policy_json, provider, model, key_ref,
                       created_at, updated_at)
    VALUES (${workId}, ${input.ownerRef}, ${input.title},
            ${input.premise ?? ""}, '', 'setup', NULL, NULL,
            ${input.provider ?? null}, ${input.model ?? null},
            ${input.keyRef ?? null}, ${t}, ${t})
    RETURNING *
  `)) as Row[];
  const threadRows = (await db.all(sql`
    INSERT INTO chat_threads (id, work_id, created_at)
    VALUES (${threadId}, ${workId}, ${t})
    RETURNING *
  `)) as Row[];
  return {
    work: rowToWork(workRows[0]!),
    thread: rowToThread(threadRows[0]!),
  };
}

export async function getWorkById(
  db: DbLike,
  id: string,
): Promise<Work | null> {
  const r = (await db.get(
    sql`SELECT * FROM works WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToWork(r) : null;
}

export async function listWorksByOwner(
  db: DbLike,
  ownerRef: string,
): Promise<Work[]> {
  const rows = (await db.all(
    sql`SELECT * FROM works WHERE owner_ref = ${ownerRef}
        ORDER BY updated_at DESC`,
  )) as Row[];
  return rows.map(rowToWork);
}

export async function patchWork(
  db: DbLike,
  input: {
    id: string;
    title?: string;
    premise?: string;
    genre?: string;
    status?: WorkStatus;
    charter?: unknown;
    policy?: unknown;
  },
): Promise<Work | null> {
  const cur = await getWorkById(db, input.id);
  if (!cur) return null;
  const rows = (await db.all(sql`
    UPDATE works SET
      title = ${input.title ?? cur.title},
      premise = ${input.premise ?? cur.premise},
      genre = ${input.genre ?? cur.genre},
      status = ${input.status ?? cur.status},
      charter_json = ${input.charter === undefined ? (cur.charter === null ? null : JSON.stringify(cur.charter)) : JSON.stringify(input.charter)},
      policy_json = ${input.policy === undefined ? (cur.policy === null ? null : JSON.stringify(cur.policy)) : JSON.stringify(input.policy)},
      updated_at = ${now()}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rowToWork(rows[0]!);
}

/** provider/model/key_ref の設定 (設定タブ用)。 */
export async function updateWorkConfig(
  db: DbLike,
  input: {
    id: string;
    keyRef?: string | null;
    provider?: string | null;
    model?: string;
  },
): Promise<Work | null> {
  const cur = await getWorkById(db, input.id);
  if (!cur) return null;
  const rows = (await db.all(sql`
    UPDATE works SET
      key_ref = ${input.keyRef === undefined ? cur.key_ref : input.keyRef},
      provider = ${input.provider === undefined ? cur.provider : input.provider},
      model = ${input.model ?? cur.model},
      updated_at = ${now()}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rowToWork(rows[0]!);
}

export async function getThreadById(
  db: DbLike,
  id: string,
): Promise<ChatThread | null> {
  const r = (await db.get(
    sql`SELECT * FROM chat_threads WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToThread(r) : null;
}

export async function getThreadByWorkId(
  db: DbLike,
  workId: string,
): Promise<ChatThread | null> {
  const r = (await db.get(
    sql`SELECT * FROM chat_threads WHERE work_id = ${workId}`,
  )) as Row | undefined;
  return r ? rowToThread(r) : null;
}

export async function listMessages(
  db: DbLike,
  threadId: string,
): Promise<ChatMessage[]> {
  const rows = (await db.all(
    sql`SELECT * FROM chat_messages WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToMessage);
}

/**
 * メッセージ追記。job_id 指定時はユニーク制約で冪等化する
 * (orchestrator の再開で同じ assistant メッセージを二重確定しない)。
 */
export async function appendMessage(
  db: DbLike,
  input: {
    threadId: string;
    role: ChatRole;
    content: string;
    jobId?: string | null;
  },
): Promise<ChatMessage> {
  const id = crypto.randomUUID();
  const rows = (await db.all(sql`
    INSERT INTO chat_messages (id, thread_id, role, content, job_id, created_at)
    VALUES (${id}, ${input.threadId}, ${input.role}, ${input.content},
            ${input.jobId ?? null}, ${now()})
    ON CONFLICT(job_id) DO NOTHING
    RETURNING *
  `)) as Row[];
  if (rows.length > 0) return rowToMessage(rows[0]!);
  const existing = await getMessageByJobId(db, input.jobId!);
  if (!existing) throw new RepoError("internal", "insert failed");
  return existing;
}

// ---------------------------------------------------------------------------
// better-auth が管理する user テーブルの最小読み取り (dev-login 用)。
// ユーザー管理の書き込みはすべて better-auth 側に任せる。
// ---------------------------------------------------------------------------

export async function getUserIdByEmail(
  db: DbLike,
  email: string,
): Promise<string | null> {
  const r = (await db.get(
    sql`SELECT id FROM user WHERE email = ${email}`,
  )) as Row | undefined;
  return r ? String(r.id) : null;
}

export async function getMessageByJobId(
  db: DbLike,
  jobId: string,
): Promise<ChatMessage | null> {
  const r = (await db.get(
    sql`SELECT * FROM chat_messages WHERE job_id = ${jobId}`,
  )) as Row | undefined;
  return r ? rowToMessage(r) : null;
}

export type {
  AgentJob,
  CanonFact,
  ChatMessage,
  ChatRole,
  ChatThread,
  DependencyEdge,
  DependencyEdgeInput,
  Episode,
  JobStatus,
  ProgressEvent,
  ProgressEventType,
  Proposal,
  ProviderKey,
  Scene,
  SceneRevision,
  Work,
  WorkStatus,
  WritingContract,
};

// ---------------------------------------------------------------------------
// Phase 1b: episodes / scenes / scene_revisions / writing_contracts /
//           canon_facts / proposals
// ---------------------------------------------------------------------------

function rowToEpisode(r: Row): Episode {
  return EpisodeSchema.parse({
    id: r.id,
    work_id: r.work_id,
    ord: r.ord,
    title: r.title,
    status: r.status,
    created_at: r.created_at,
  });
}

function rowToScene(r: Row): Scene {
  return SceneSchema.parse({
    id: r.id,
    episode_id: r.episode_id,
    ord: r.ord,
    title: r.title,
    purpose: r.purpose,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

function rowToRevision(r: Row): SceneRevision {
  return SceneRevisionSchema.parse({
    id: r.id,
    scene_id: r.scene_id,
    rev_no: r.rev_no,
    content_json: JSON.parse(String(r.content_json)),
    source: r.source,
    job_id: r.job_id ?? null,
    change_set_id: r.change_set_id ?? null,
    created_at: r.created_at,
  });
}

function rowToContract(r: Row): WritingContract {
  return WritingContractSchema.parse({
    id: r.id,
    scene_id: r.scene_id,
    status: r.status,
    payload: WritingContractPayloadSchema.parse(JSON.parse(String(r.payload))),
    created_at: r.created_at,
    decided_at: r.decided_at ?? null,
  });
}

function rowToCanonFact(r: Row): CanonFact {
  return CanonFactSchema.parse({
    id: r.id,
    work_id: r.work_id,
    statement: r.statement,
    provenance: r.provenance,
    valid_from_rev: r.valid_from_rev ?? null,
    valid_to_rev: r.valid_to_rev ?? null,
    created_at: r.created_at,
  });
}

function rowToProposal(r: Row): Proposal {
  return ProposalSchema.parse({
    id: r.id,
    work_id: r.work_id,
    thread_id: r.thread_id,
    message_id: r.message_id,
    kind: r.kind,
    payload: JSON.parse(String(r.payload)),
    status: r.status,
    decided_at: r.decided_at ?? null,
    created_at: r.created_at,
  });
}

export async function createEpisode(
  db: DbLike,
  input: { workId: string; title: string },
): Promise<Episode> {
  const rows = (await db.all(sql`
    INSERT INTO episodes (id, work_id, ord, title, status, created_at)
    VALUES (${crypto.randomUUID()}, ${input.workId},
            (SELECT COALESCE(MAX(ord), 0) + 1 FROM episodes WHERE work_id = ${input.workId}),
            ${input.title}, 'active', ${now()})
    RETURNING *
  `)) as Row[];
  return rowToEpisode(rows[0]!);
}

export async function getLatestEpisode(
  db: DbLike,
  workId: string,
): Promise<Episode | null> {
  const r = (await db.get(
    sql`SELECT * FROM episodes WHERE work_id = ${workId}
        ORDER BY ord DESC LIMIT 1`,
  )) as Row | undefined;
  return r ? rowToEpisode(r) : null;
}

export async function listEpisodesByWork(
  db: DbLike,
  workId: string,
): Promise<Episode[]> {
  const rows = (await db.all(
    sql`SELECT * FROM episodes WHERE work_id = ${workId} ORDER BY ord ASC`,
  )) as Row[];
  return rows.map(rowToEpisode);
}

export async function findEpisodeByTitle(
  db: DbLike,
  workId: string,
  title: string,
): Promise<Episode | null> {
  const r = (await db.get(
    sql`SELECT * FROM episodes WHERE work_id = ${workId} AND title = ${title}
        ORDER BY ord ASC LIMIT 1`,
  )) as Row | undefined;
  return r ? rowToEpisode(r) : null;
}

export async function createScene(
  db: DbLike,
  input: { episodeId: string; title: string; purpose: string; status: string },
): Promise<Scene> {
  const t = now();
  const rows = (await db.all(sql`
    INSERT INTO scenes (id, episode_id, ord, title, purpose, status, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${input.episodeId},
            (SELECT COALESCE(MAX(ord), 0) + 1 FROM scenes WHERE episode_id = ${input.episodeId}),
            ${input.title}, ${input.purpose}, ${input.status}, ${t}, ${t})
    RETURNING *
  `)) as Row[];
  return rowToScene(rows[0]!);
}

export async function getSceneById(
  db: DbLike,
  id: string,
): Promise<Scene | null> {
  const r = (await db.get(
    sql`SELECT * FROM scenes WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToScene(r) : null;
}

/** シーンが属する作品の owner を取る (権限チェック用)。 */
export async function getWorkIdBySceneId(
  db: DbLike,
  sceneId: string,
): Promise<string | null> {
  const r = (await db.get(
    sql`SELECT e.work_id FROM scenes s
        JOIN episodes e ON e.id = s.episode_id
        WHERE s.id = ${sceneId}`,
  )) as Row | undefined;
  return r ? String(r.work_id) : null;
}

export async function listScenesByEpisode(
  db: DbLike,
  episodeId: string,
): Promise<Scene[]> {
  const rows = (await db.all(
    sql`SELECT * FROM scenes WHERE episode_id = ${episodeId}
        ORDER BY ord ASC`,
  )) as Row[];
  return rows.map(rowToScene);
}

export async function listScenesByWork(
  db: DbLike,
  workId: string,
): Promise<Scene[]> {
  const rows = (await db.all(
    sql`SELECT s.* FROM scenes s
        JOIN episodes e ON e.id = s.episode_id
        WHERE e.work_id = ${workId}
        ORDER BY e.ord ASC, s.ord ASC`,
  )) as Row[];
  return rows.map(rowToScene);
}

export async function updateSceneStatus(
  db: DbLike,
  input: { id: string; status: string },
): Promise<Scene | null> {
  const rows = (await db.all(sql`
    UPDATE scenes SET status = ${input.status}, updated_at = ${now()}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rows.length > 0 ? rowToScene(rows[0]!) : null;
}

/** rev_no = 最大+1 でリビジョンを作る (ユニーク制約で重複 rev_no を防ぐ)。 */
export async function createSceneRevision(
  db: DbLike,
  input: {
    sceneId: string;
    contentJson: unknown;
    source: string;
    jobId?: string | null;
    changeSetId?: string | null;
  },
): Promise<SceneRevision> {
  const rows = (await db.all(sql`
    INSERT INTO scene_revisions (id, scene_id, rev_no, content_json, source, job_id, change_set_id, created_at)
    VALUES (${crypto.randomUUID()}, ${input.sceneId},
            (SELECT COALESCE(MAX(rev_no), 0) + 1 FROM scene_revisions WHERE scene_id = ${input.sceneId}),
            ${JSON.stringify(input.contentJson)}, ${input.source},
            ${input.jobId ?? null}, ${input.changeSetId ?? null}, ${now()})
    RETURNING *
  `)) as Row[];
  return rowToRevision(rows[0]!);
}

export async function listRevisionsByScene(
  db: DbLike,
  sceneId: string,
): Promise<SceneRevision[]> {
  const rows = (await db.all(
    sql`SELECT * FROM scene_revisions WHERE scene_id = ${sceneId}
        ORDER BY rev_no ASC`,
  )) as Row[];
  return rows.map(rowToRevision);
}

export async function listRevisionsByWork(
  db: DbLike,
  workId: string,
): Promise<SceneRevision[]> {
  const rows = (await db.all(
    sql`SELECT r.* FROM scene_revisions r
        JOIN scenes s ON s.id = r.scene_id
        JOIN episodes e ON e.id = s.episode_id
        WHERE e.work_id = ${workId}
        ORDER BY e.ord ASC, s.ord ASC, r.rev_no ASC`,
  )) as Row[];
  return rows.map(rowToRevision);
}

export async function createWritingContract(
  db: DbLike,
  input: { sceneId: string; status: string; payload: unknown; decidedAt?: number | null },
): Promise<WritingContract> {
  const rows = (await db.all(sql`
    INSERT INTO writing_contracts (id, scene_id, status, payload, created_at, decided_at)
    VALUES (${crypto.randomUUID()}, ${input.sceneId}, ${input.status},
            ${JSON.stringify(input.payload)}, ${now()}, ${input.decidedAt ?? null})
    RETURNING *
  `)) as Row[];
  return rowToContract(rows[0]!);
}

export async function getContractById(
  db: DbLike,
  id: string,
): Promise<WritingContract | null> {
  const r = (await db.get(
    sql`SELECT * FROM writing_contracts WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToContract(r) : null;
}

export async function getLatestContractByScene(
  db: DbLike,
  sceneId: string,
): Promise<WritingContract | null> {
  const r = (await db.get(
    sql`SELECT * FROM writing_contracts WHERE scene_id = ${sceneId}
        ORDER BY created_at DESC LIMIT 1`,
  )) as Row | undefined;
  return r ? rowToContract(r) : null;
}

export async function listContractsByWork(
  db: DbLike,
  workId: string,
): Promise<WritingContract[]> {
  const rows = (await db.all(
    sql`SELECT c.* FROM writing_contracts c
        JOIN scenes s ON s.id = c.scene_id
        JOIN episodes e ON e.id = s.episode_id
        WHERE e.work_id = ${workId}
        ORDER BY c.created_at ASC`,
  )) as Row[];
  return rows.map(rowToContract);
}

export async function updateContractStatus(
  db: DbLike,
  input: { id: string; status: string },
): Promise<WritingContract | null> {
  const rows = (await db.all(sql`
    UPDATE writing_contracts SET status = ${input.status}, decided_at = ${now()}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rows.length > 0 ? rowToContract(rows[0]!) : null;
}

/** 正典メモを追加。statement 完全一致は重複スキップして追加件数を返す。 */
export async function addCanonFacts(
  db: DbLike,
  input: { workId: string; statements: string[]; provenance: string },
): Promise<{ canonFacts: CanonFact[]; added: number }> {
  let added = 0;
  for (const statement of input.statements) {
    const rows = (await db.all(sql`
      INSERT INTO canon_facts (id, work_id, statement, provenance, created_at)
      VALUES (${crypto.randomUUID()}, ${input.workId}, ${statement},
              ${input.provenance}, ${now()})
      ON CONFLICT DO NOTHING
      RETURNING *
    `)) as Row[];
    added += rows.length;
  }
  return { canonFacts: await listCanonFactsByWork(db, input.workId), added };
}

/** 現行の正典メモのみ (valid_to_rev IS NULL, spec §6.3)。 */
export async function listCanonFactsByWork(
  db: DbLike,
  workId: string,
): Promise<CanonFact[]> {
  const rows = (await db.all(
    sql`SELECT * FROM canon_facts WHERE work_id = ${workId}
        AND valid_to_rev IS NULL
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToCanonFact);
}

/** 全履歴行 (現行+閉じた) — /canon/history.md と影響分析用。 */
export async function listAllCanonFactsByWork(
  db: DbLike,
  workId: string,
): Promise<CanonFact[]> {
  const rows = (await db.all(
    sql`SELECT * FROM canon_facts WHERE work_id = ${workId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToCanonFact);
}

export async function getCanonFactById(
  db: DbLike,
  id: string,
): Promise<CanonFact | null> {
  const r = (await db.get(
    sql`SELECT * FROM canon_facts WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToCanonFact(r) : null;
}

/** 提案の作成 (message_id+kind のユニーク制約で冪等)。 */
export async function createProposal(
  db: DbLike,
  input: {
    workId: string;
    threadId: string;
    messageId: string;
    kind: string;
    payload: unknown;
  },
): Promise<Proposal> {
  const rows = (await db.all(sql`
    INSERT INTO proposals (id, work_id, thread_id, message_id, kind, payload, status, decided_at, created_at)
    VALUES (${crypto.randomUUID()}, ${input.workId}, ${input.threadId},
            ${input.messageId}, ${input.kind}, ${JSON.stringify(input.payload)},
            'pending', NULL, ${now()})
    ON CONFLICT(message_id, kind) DO NOTHING
    RETURNING *
  `)) as Row[];
  if (rows.length > 0) return rowToProposal(rows[0]!);
  const existing = (await db.get(
    sql`SELECT * FROM proposals WHERE message_id = ${input.messageId}
        AND kind = ${input.kind}`,
  )) as Row | undefined;
  if (!existing) throw new RepoError("internal", "insert failed");
  return rowToProposal(existing);
}

export async function getProposalById(
  db: DbLike,
  id: string,
): Promise<Proposal | null> {
  const r = (await db.get(
    sql`SELECT * FROM proposals WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToProposal(r) : null;
}

export async function updateProposalStatus(
  db: DbLike,
  input: { id: string; status: string },
): Promise<Proposal | null> {
  const rows = (await db.all(sql`
    UPDATE proposals SET status = ${input.status}, decided_at = ${now()}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rows.length > 0 ? rowToProposal(rows[0]!) : null;
}

export async function listProposalsByWork(
  db: DbLike,
  workId: string,
): Promise<Proposal[]> {
  const rows = (await db.all(
    sql`SELECT * FROM proposals WHERE work_id = ${workId}
        ORDER BY created_at DESC`,
  )) as Row[];
  return rows.map(rowToProposal);
}

export async function listPendingProposalsByWork(
  db: DbLike,
  workId: string,
): Promise<Proposal[]> {
  const rows = (await db.all(
    sql`SELECT * FROM proposals WHERE work_id = ${workId}
        AND status = 'pending' ORDER BY created_at ASC`,
  )) as Row[];
  return rows.map(rowToProposal);
}

export async function getEpisodeById(
  db: DbLike,
  id: string,
): Promise<Episode | null> {
  const r = (await db.get(
    sql`SELECT * FROM episodes WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToEpisode(r) : null;
}

// ---------------------------------------------------------------------------
// Phase 2a: dependency_edges (writer の依存宣言の記録先, spec §6.4)
// ---------------------------------------------------------------------------

function rowToDependencyEdge(r: Row): DependencyEdge {
  return DependencyEdgeSchema.parse({
    id: r.id,
    work_id: r.work_id,
    scene_id: r.scene_id,
    target_kind: r.target_kind,
    target_ref: r.target_ref,
    created_at: r.created_at,
  });
}

/** 依存宣言を記録。(scene_id,target_kind,target_ref) の完全一致は重複スキップ。 */
export async function addDependencyEdges(
  db: DbLike,
  input: {
    workId: string;
    sceneId: string;
    edges: DependencyEdgeInput[];
  },
): Promise<{ edges: DependencyEdge[]; added: number }> {
  let added = 0;
  for (const e of input.edges) {
    const rows = (await db.all(sql`
      INSERT INTO dependency_edges
        (id, work_id, scene_id, target_kind, target_ref, created_at)
      VALUES (${crypto.randomUUID()}, ${input.workId}, ${input.sceneId},
              ${e.target_kind}, ${e.target_ref}, ${now()})
      ON CONFLICT DO NOTHING
      RETURNING *
    `)) as Row[];
    added += rows.length;
  }
  return {
    edges: await listDependencyEdgesByScene(db, input.sceneId),
    added,
  };
}

export async function listDependencyEdgesByScene(
  db: DbLike,
  sceneId: string,
): Promise<DependencyEdge[]> {
  const rows = (await db.all(
    sql`SELECT * FROM dependency_edges WHERE scene_id = ${sceneId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToDependencyEdge);
}

export async function listDependencyEdgesByWork(
  db: DbLike,
  workId: string,
): Promise<DependencyEdge[]> {
  const rows = (await db.all(
    sql`SELECT * FROM dependency_edges WHERE work_id = ${workId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToDependencyEdge);
}

// ---------------------------------------------------------------------------
// Phase 2b: 変更セット + 影響分析 + 正典リビジョン (spec §5, §5.5, §6.3, §3)
// ---------------------------------------------------------------------------

function rowToChangeSet(r: Row): ChangeSet {
  return ChangeSetSchema.parse({
    id: r.id,
    work_id: r.work_id,
    kind: r.kind,
    title: r.title,
    description: r.description,
    ops: JSON.parse(String(r.ops)),
    status: r.status,
    impact: JSON.parse(String(r.impact)),
    force: r.force ?? 0,
    message_id: r.message_id ?? null,
    created_at: r.created_at,
    decided_at: r.decided_at ?? null,
    applied_at: r.applied_at ?? null,
  });
}

function rowToReviewFinding(r: Row): ReviewFinding {
  return ReviewFindingSchema.parse({
    id: r.id,
    change_set_id: r.change_set_id,
    kind: r.kind,
    severity: r.severity,
    summary: r.summary,
    detail: r.detail,
    scene_id: r.scene_id ?? null,
    fact_id: r.fact_id ?? null,
    status: r.status,
    created_at: r.created_at,
  });
}

/**
 * 変更セットの作成。message_id つきはユニーク制約で冪等
 * (orchestrator ジョブの再開で同じ提案を2重に作らない)。
 */
export async function createChangeSet(
  db: DbLike,
  input: {
    workId: string;
    kind?: string;
    title: string;
    description?: string;
    ops: ChangeSetOp[];
    status?: string;
    impact: ChangeSetImpact;
    force?: number;
    messageId?: string | null;
    decidedAt?: number | null;
    appliedAt?: number | null;
  },
): Promise<ChangeSet> {
  const id = crypto.randomUUID();
  const rows = (await db.all(sql`
    INSERT INTO change_sets
      (id, work_id, kind, title, description, ops, status, impact, force,
       message_id, created_at, decided_at, applied_at)
    VALUES (${id}, ${input.workId}, ${input.kind ?? "normal"},
            ${input.title}, ${input.description ?? ""},
            ${JSON.stringify(input.ops)}, ${input.status ?? "proposed"},
            ${JSON.stringify(input.impact)}, ${input.force ?? 0},
            ${input.messageId ?? null}, ${now()},
            ${input.decidedAt ?? null}, ${input.appliedAt ?? null})
    ON CONFLICT DO NOTHING
    RETURNING *
  `)) as Row[];
  if (rows.length > 0) return rowToChangeSet(rows[0]!);
  // 同じ message_id の既存行 (冪等ヒット) を返す
  if (input.messageId) {
    const r = (await db.get(
      sql`SELECT * FROM change_sets WHERE message_id = ${input.messageId}`,
    )) as Row | undefined;
    if (r) return rowToChangeSet(r);
  }
  throw new RepoError("internal", "createChangeSet: insert failed");
}

export async function getChangeSetById(
  db: DbLike,
  id: string,
): Promise<ChangeSet | null> {
  const r = (await db.get(
    sql`SELECT * FROM change_sets WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToChangeSet(r) : null;
}

export async function listFindingsByChangeSet(
  db: DbLike,
  changeSetId: string,
): Promise<ReviewFinding[]> {
  const rows = (await db.all(
    sql`SELECT * FROM review_findings WHERE change_set_id = ${changeSetId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToReviewFinding);
}

export async function getChangeSetWithFindings(
  db: DbLike,
  id: string,
): Promise<ChangeSetWithFindings | null> {
  const cs = await getChangeSetById(db, id);
  if (!cs) return null;
  const findings = await listFindingsByChangeSet(db, id);
  return ChangeSetWithFindingsSchema.parse({ ...cs, findings });
}

export async function listChangeSetsByWork(
  db: DbLike,
  workId: string,
): Promise<ChangeSetWithFindings[]> {
  const rows = (await db.all(
    sql`SELECT * FROM change_sets WHERE work_id = ${workId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  const out: ChangeSetWithFindings[] = [];
  for (const r of rows) {
    const cs = rowToChangeSet(r);
    const findings = await listFindingsByChangeSet(db, cs.id);
    out.push(ChangeSetWithFindingsSchema.parse({ ...cs, findings }));
  }
  return out;
}

/** 変更セットの状態/属性を更新 (propose→applied/rejected、force 昇格)。 */
export async function updateChangeSetState(
  db: DbLike,
  input: {
    id: string;
    status?: string;
    kind?: string;
    force?: number;
    decidedAt?: number | null;
    appliedAt?: number | null;
  },
): Promise<ChangeSet | null> {
  const cur = await getChangeSetById(db, input.id);
  if (!cur) return null;
  const rows = (await db.all(sql`
    UPDATE change_sets SET
      status = ${input.status ?? cur.status},
      kind = ${input.kind ?? cur.kind},
      force = ${input.force ?? cur.force},
      decided_at = ${input.decidedAt === undefined ? cur.decided_at : input.decidedAt},
      applied_at = ${input.appliedAt === undefined ? cur.applied_at : input.appliedAt}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rows.length > 0 ? rowToChangeSet(rows[0]!) : null;
}

/** review_findings の記録 (change_set+kind+summary+scene_id で重複スキップ)。 */
export async function addReviewFindings(
  db: DbLike,
  input: {
    changeSetId: string;
    findings: {
      kind: string;
      severity: string;
      summary: string;
      detail?: string;
      sceneId?: string | null;
      factId?: string | null;
    }[];
  },
): Promise<{ findings: ReviewFinding[]; added: number }> {
  const existing = await listFindingsByChangeSet(db, input.changeSetId);
  const seen = new Set(
    existing.map(
      (f) => `${f.kind}${f.summary}${f.scene_id ?? ""}${f.fact_id ?? ""}`,
    ),
  );
  let added = 0;
  for (const f of input.findings) {
    const key = `${f.kind}${f.summary}${f.sceneId ?? ""}${f.factId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = (await db.all(sql`
      INSERT INTO review_findings
        (id, change_set_id, kind, severity, summary, detail, scene_id, fact_id, status, created_at)
      VALUES (${crypto.randomUUID()}, ${input.changeSetId}, ${f.kind},
              ${f.severity}, ${f.summary}, ${f.detail ?? ""},
              ${f.sceneId ?? null}, ${f.factId ?? null}, 'open', ${now()})
      RETURNING *
    `)) as Row[];
    added += rows.length;
  }
  return {
    findings: await listFindingsByChangeSet(db, input.changeSetId),
    added,
  };
}

export async function setReviewFindingStatus(
  db: DbLike,
  input: { id: string; status: string },
): Promise<ReviewFinding | null> {
  const rows = (await db.all(sql`
    UPDATE review_findings SET status = ${input.status}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rows.length > 0 ? rowToReviewFinding(rows[0]!) : null;
}

export async function getReviewFindingById(
  db: DbLike,
  id: string,
): Promise<ReviewFinding | null> {
  const r = (await db.get(
    sql`SELECT * FROM review_findings WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToReviewFinding(r) : null;
}

// --- 影響分析 (決定的 MVP, spec §3) ---

/** 文面の正規化 (Unicode正規化 + 空白/記号除去 + 小文字化)。 */
function normalizeStatement(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[、。・「」『』!?.,・…—\-~〜]/g, "");
}

/** 高一致の簡易検査: 完全一致 または 相互の部分一致 (4文字以上のみ)。 */
function statementsMatch(a: string, b: string): boolean {
  const x = normalizeStatement(a);
  const y = normalizeStatement(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4) return x.includes(y) || y.includes(x);
  return false;
}

/**
 * ops から影響対象を決定的に列挙する (spec §3 の MVP 版)。
 * - 変更/廃止する fact に依存宣言で繋がる scenes
 * - その fact の statement と高一致する他の現行 canon_facts
 * - 影響シーンの最新 contracts
 */
export async function computeChangeSetImpact(
  db: DbLike,
  input: { workId: string; ops: ChangeSetOp[] },
): Promise<ChangeSetImpact> {
  const scenes = new Map<string, { id: string; title: string; reason: string }>();
  const facts = new Map<
    string,
    { id: string; statement: string; reason: string }
  >();
  const contracts = new Map<
    string,
    { id: string; scene_id: string; reason: string }
  >();

  const edges = await listDependencyEdgesByWork(db, input.workId);
  const currentFacts = await listCanonFactsByWork(db, input.workId);

  const linkContractsForScene = async (sceneId: string) => {
    const contract = await getLatestContractByScene(db, sceneId);
    if (contract && !contracts.has(contract.id)) {
      contracts.set(contract.id, {
        id: contract.id,
        scene_id: contract.scene_id,
        reason: "影響シーンの契約",
      });
    }
  };

  for (const op of input.ops) {
    if (op.op === "retire_fact" || op.op === "revise_fact") {
      const fact = await getCanonFactById(db, op.fact_id);
      if (!fact) continue;
      // 依存宣言で繋がる scenes
      for (const edge of edges) {
        if (edge.target_kind !== "canon_fact") continue;
        if (
          edge.target_ref === fact.id ||
          statementsMatch(edge.target_ref, fact.statement)
        ) {
          if (!scenes.has(edge.scene_id)) {
            const scene = await getSceneById(db, edge.scene_id);
            scenes.set(edge.scene_id, {
              id: edge.scene_id,
              title: scene?.title ?? "(不明なシーン)",
              reason: `依存宣言「${edge.target_ref}」`,
            });
          }
        }
      }
      // 文面が近い他の現行正典
      for (const other of currentFacts) {
        if (other.id === fact.id) continue;
        if (statementsMatch(other.statement, fact.statement)) {
          facts.set(other.id, {
            id: other.id,
            statement: other.statement,
            reason: "変更対象の正典と文面が近い",
          });
        }
      }
      // revise: 新しい文面とも一致する既存正典を拾う
      if (op.op === "revise_fact") {
        for (const other of currentFacts) {
          if (other.id === fact.id) continue;
          if (statementsMatch(other.statement, op.new_statement)) {
            facts.set(other.id, {
              id: other.id,
              statement: other.statement,
              reason: "新しい文面と近い既存の正典",
            });
          }
        }
      }
    } else if (op.op === "add_fact") {
      for (const other of currentFacts) {
        if (statementsMatch(other.statement, op.statement)) {
          facts.set(other.id, {
            id: other.id,
            statement: other.statement,
            reason: "追加予定の文面と近い既存の正典",
          });
        }
      }
    }
    // update_work: 構造情報の変更は個別シーンへの影響を列挙しない
  }

  for (const sceneId of scenes.keys()) {
    await linkContractsForScene(sceneId);
  }

  const parts: string[] = [];
  if (scenes.size > 0) parts.push(`シーン ${scenes.size} 件`);
  if (facts.size > 0) parts.push(`正典 ${facts.size} 件`);
  if (contracts.size > 0) parts.push(`契約 ${contracts.size} 件`);
  const summary =
    parts.length > 0
      ? `${parts.join("・")}に影響する可能性`
      : "影響対象は見つかりませんでした";

  return {
    scenes: [...scenes.values()],
    facts: [...facts.values()],
    contracts: [...contracts.values()],
    summary,
  };
}

/** 手編集リビジョン用の変更セット impact (spec §5.5)。 */
export function manualEditImpact(input: {
  sceneId: string;
  sceneTitle: string;
}): ChangeSetImpact {
  return {
    scenes: [
      {
        id: input.sceneId,
        title: input.sceneTitle,
        reason: "手編集の対象シーン",
      },
    ],
    facts: [],
    contracts: [],
    summary: "手編集による本文の変更",
  };
}

// --- ops 適用 (spec §5.3) ---

async function closeCanonFact(
  db: DbLike,
  input: { factId: string; validToRev: number },
): Promise<boolean> {
  const rows = (await db.all(sql`
    UPDATE canon_facts SET valid_to_rev = ${input.validToRev}
    WHERE id = ${input.factId} AND valid_to_rev IS NULL
    RETURNING id
  `)) as Row[];
  return rows.length > 0;
}

async function insertCanonFactRev(
  db: DbLike,
  input: {
    workId: string;
    statement: string;
    provenance: string;
    validFromRev: number;
  },
): Promise<void> {
  await db.all(sql`
    INSERT INTO canon_facts
      (id, work_id, statement, provenance, valid_from_rev, valid_to_rev, created_at)
    VALUES (${crypto.randomUUID()}, ${input.workId}, ${input.statement},
            ${input.provenance}, ${input.validFromRev}, NULL, ${now()})
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
}

/**
 * 変更セットの ops を適用し、works.canon_rev を +1 する (spec §5.3)。
 * - retire_fact: valid_to_rev を新 rev に設定して閉じる
 * - revise_fact: 旧行を閉じ、新行を valid_from_rev=新 rev で挿入
 * - add_fact: 新行を挿入
 * - update_work: works の構造情報をパッチ
 * force=true のとき kind=force_override に昇格する (spec §5.4)。
 * 適用済みの変更セットは冪等に現状を返す。
 */
export async function applyChangeSet(
  db: DbLike,
  input: { changeSetId: string; force?: boolean },
): Promise<{ changeSet: ChangeSetWithFindings; newCanonRev: number } | null> {
  const cs = await getChangeSetById(db, input.changeSetId);
  if (!cs) return null;
  if (cs.status === "applied") {
    const work = await getWorkById(db, cs.work_id);
    const withFindings = await getChangeSetWithFindings(db, cs.id);
    if (!withFindings) return null;
    return { changeSet: withFindings, newCanonRev: work?.canon_rev ?? 0 };
  }

  const work = await getWorkById(db, cs.work_id);
  if (!work) return null;
  const newRev = work.canon_rev + 1;
  const provenance = `change_set:${cs.id}`;

  for (const op of cs.ops) {
    if (op.op === "retire_fact") {
      await closeCanonFact(db, { factId: op.fact_id, validToRev: newRev });
    } else if (op.op === "revise_fact") {
      const closed = await closeCanonFact(db, {
        factId: op.fact_id,
        validToRev: newRev,
      });
      if (closed) {
        await insertCanonFactRev(db, {
          workId: cs.work_id,
          statement: op.new_statement,
          provenance,
          validFromRev: newRev,
        });
      }
    } else if (op.op === "add_fact") {
      await insertCanonFactRev(db, {
        workId: cs.work_id,
        statement: op.statement,
        provenance,
        validFromRev: newRev,
      });
    } else if (op.op === "update_work") {
      const p = op.patch;
      await patchWork(db, {
        id: cs.work_id,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.premise !== undefined ? { premise: p.premise } : {}),
        ...(p.genre !== undefined ? { genre: p.genre } : {}),
        ...(p.charter !== undefined ? { charter: p.charter } : {}),
        ...(p.policy !== undefined ? { policy: p.policy } : {}),
      });
    }
  }

  await db.run(sql`
    UPDATE works SET canon_rev = ${newRev}, updated_at = ${now()}
    WHERE id = ${cs.work_id}
  `);
  const kind = input.force ? "force_override" : cs.kind;
  const updated = await updateChangeSetState(db, {
    id: cs.id,
    status: "applied",
    kind,
    force: input.force ? 1 : cs.force,
    decidedAt: now(),
    appliedAt: now(),
  });
  if (!updated) return null;
  const findings = await listFindingsByChangeSet(db, cs.id);
  return {
    changeSet: ChangeSetWithFindingsSchema.parse({ ...updated, findings }),
    newCanonRev: newRev,
  };
}
