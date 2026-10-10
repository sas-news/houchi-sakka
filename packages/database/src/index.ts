import { sql, type SQLWrapper } from "drizzle-orm";
import {
  AgentJobSchema,
  CanonFactSchema,
  ChatMessageSchema,
  ChatRoleSchema,
  ChatThreadSchema,
  DependencyEdgeSchema,
  EpisodeSchema,
  JobStatusSchema,
  ProgressEventSchema,
  ProposalSchema,
  ProviderKeySchema,
  SceneRevisionSchema,
  SceneSchema,
  WorkSchema,
  WorkStatusSchema,
  WritingContractPayloadSchema,
  WritingContractSchema,
  type AgentJob,
  type CanonFact,
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
  },
): Promise<SceneRevision> {
  const rows = (await db.all(sql`
    INSERT INTO scene_revisions (id, scene_id, rev_no, content_json, source, job_id, created_at)
    VALUES (${crypto.randomUUID()}, ${input.sceneId},
            (SELECT COALESCE(MAX(rev_no), 0) + 1 FROM scene_revisions WHERE scene_id = ${input.sceneId}),
            ${JSON.stringify(input.contentJson)}, ${input.source},
            ${input.jobId ?? null}, ${now()})
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

export async function listCanonFactsByWork(
  db: DbLike,
  workId: string,
): Promise<CanonFact[]> {
  const rows = (await db.all(
    sql`SELECT * FROM canon_facts WHERE work_id = ${workId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToCanonFact);
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
