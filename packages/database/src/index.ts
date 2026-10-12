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
  EntityAliasSchema,
  EntityKindSchema,
  EntityWithAliasesSchema,
  EpisodeSchema,
  JobStatusSchema,
  KnowledgeEventSchema,
  ProgressEventSchema,
  ProposalSchema,
  ProviderKeySchema,
  ReleaseSchema,
  ReleaseStatusSchema,
  ReviewFindingSchema,
  SceneRevisionSchema,
  SceneSchema,
  StoryEntitySchema,
  textToTiptapDoc,
  tiptapDocToText,
  WorkSchema,
  WorkStatusSchema,
  WritingContractPayloadSchema,
  WritingContractSchema,
  type AgentJob,
  type CanonFact,
  type CanonFactInput,
  type ChangeSet,
  type ChangeSetImpact,
  type ChangeSetOp,
  type ChangeSetWithFindings,
  type ChatMessage,
  type ChatRole,
  type ChatThread,
  type DependencyEdge,
  type DependencyEdgeInput,
  type EntityAlias,
  type EntityWithAliases,
  type Episode,
  type JobStatus,
  type KnowledgeEvent,
  type ProgressEvent,
  type ProgressEventType,
  type PreApplyCheck,
  type PreApplyCheckItem,
  type Proposal,
  type ProviderKey,
  type PublicWorkEpisode,
  type Release,
  type ReleaseScene,
  type ReviewFinding,
  type Scene,
  type SceneRevision,
  type StoryEntity,
  type Work,
  type WorkStatus,
  type WritingContract,
} from "@houchi/contracts";
import { checkForbidden, checkRequiredEvents } from "@houchi/validators";
import { detectEntityMentions } from "@houchi/mentions";

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
    public readonly code:
      | "not_found"
      | "lease_conflict"
      | "conflict"
      | "internal",
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

/**
 * 作品に紐づく直近ジョブを全 status で新しい順に返す (spec §3.4)。
 * 実行履歴の表示と失敗ジョブの可視化用。failed/cancelled の
 * 理由は job.error に入っている。
 */
export async function listRecentJobsByWork(
  db: DbLike,
  workId: string,
  limit = 20,
): Promise<AgentJob[]> {
  const rows = (await db.all(
    sql`SELECT * FROM agent_jobs
        WHERE work_ref = ${workId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`,
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

/**
 * キーごとの使用中作品数 (works.key_ref → provider_keys.id)。
 * キー削除時の影響表示用 (spec §9: 削除の影響を案内する)。
 */
export async function listKeyUsageCounts(
  db: DbLike,
  ownerRef: string,
): Promise<Map<string, number>> {
  const rows = (await db.all(sql`
    SELECT key_ref AS k, COUNT(*) AS n FROM works
    WHERE owner_ref = ${ownerRef} AND key_ref IS NOT NULL
    GROUP BY key_ref
  `)) as Row[];
  return new Map(rows.map((r) => [String(r.k), Number(r.n)]));
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

export async function getMessageById(
  db: DbLike,
  id: string,
): Promise<ChatMessage | null> {
  const r = (await db.get(
    sql`SELECT * FROM chat_messages WHERE id = ${id}`,
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
    commitment: r.commitment ?? "fixed",
    disclosure: r.disclosure ?? "normal",
    provenance: r.provenance,
    valid_from_rev: r.valid_from_rev ?? null,
    valid_to_rev: r.valid_to_rev ?? null,
    // fact_ref は 0009 未適用の行/DB では列自体が無いことがあるので
    // 未定義なら null (呼び出し側で id フォールバックする)。
    fact_ref: r.fact_ref ?? null,
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

/**
 * 正典メモを追加。statement 完全一致は重複スキップして追加件数を返す。
 * statements は文字列 (commitment=fixed/disclosure=normal) か
 * {statement, commitment?, disclosure?} (spec §4.3)。
 */
export async function addCanonFacts(
  db: DbLike,
  input: {
    workId: string;
    statements: CanonFactInput[];
    provenance: string;
  },
): Promise<{ canonFacts: CanonFact[]; added: number }> {
  let added = 0;
  for (const item of input.statements) {
    const entry = typeof item === "string" ? { statement: item } : item;
    const rows = (await db.all(sql`
      INSERT INTO canon_facts
        (id, work_id, statement, commitment, disclosure, provenance, created_at)
      VALUES (${crypto.randomUUID()}, ${input.workId}, ${entry.statement},
              ${entry.commitment ?? "fixed"}, ${entry.disclosure ?? "normal"},
              ${input.provenance}, ${now()})
      ON CONFLICT DO NOTHING
      RETURNING *
    `)) as Row[];
    added += rows.length;
  }
  // fact_ref (0009 で追加した安定ID) が未設定の行は id で埋める
  // (エンティティリンク・知識イベントは fact_ref を指す)。
  await db.run(
    sql`UPDATE canon_facts SET fact_ref = id WHERE fact_ref IS NULL`,
  );
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
// 知識追跡 MVP (spec §6.3-6.4): story_entities / entity_aliases /
// fact_entities / knowledge_events。
// entity_id / fact_ref はリビジョンを跨ぐ安定ID: 行の改定 (close→insert)
// で id が変わってもリンクが切れないように、参照はすべて安定IDを指す。
// ---------------------------------------------------------------------------

function rowToStoryEntity(r: Row): StoryEntity {
  return StoryEntitySchema.parse({
    id: r.id,
    entity_id: r.entity_id,
    work_id: r.work_id,
    kind: r.kind,
    name: r.name,
    summary: r.summary ?? "",
    valid_from_rev: r.valid_from_rev ?? null,
    valid_to_rev: r.valid_to_rev ?? null,
    created_at: r.created_at,
  });
}

function rowToEntityAlias(r: Row): EntityAlias {
  return EntityAliasSchema.parse({
    id: r.id,
    entity_id: r.entity_id,
    alias: r.alias,
    created_at: r.created_at,
  });
}

function rowToKnowledgeEvent(r: Row): KnowledgeEvent {
  return KnowledgeEventSchema.parse({
    id: r.id,
    work_id: r.work_id,
    entity_id: r.entity_id,
    fact_id: r.fact_id,
    scene_id: r.scene_id ?? null,
    source: r.source ?? "記述",
    valid_from_rev: r.valid_from_rev ?? null,
    valid_to_rev: r.valid_to_rev ?? null,
    created_at: r.created_at,
  });
}

/** 現行の登場要素 (valid_to_rev IS NULL)。 */
export async function listEntitiesByWork(
  db: DbLike,
  workId: string,
): Promise<StoryEntity[]> {
  const rows = (await db.all(
    sql`SELECT * FROM story_entities WHERE work_id = ${workId}
        AND valid_to_rev IS NULL
        ORDER BY kind ASC, name ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToStoryEntity);
}

/** 全履歴行 (現行+閉じた) — 時系列モデルの確認用。 */
export async function listAllEntitiesByWork(
  db: DbLike,
  workId: string,
): Promise<StoryEntity[]> {
  const rows = (await db.all(
    sql`SELECT * FROM story_entities WHERE work_id = ${workId}
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToStoryEntity);
}

/** 安定ID (entity_id) で現行行を引く。 */
export async function getCurrentEntityByEntityId(
  db: DbLike,
  entityId: string,
): Promise<StoryEntity | null> {
  const r = (await db.get(
    sql`SELECT * FROM story_entities WHERE entity_id = ${entityId}
        AND valid_to_rev IS NULL`,
  )) as Row | undefined;
  return r ? rowToStoryEntity(r) : null;
}

/** entity_id 群の別名一覧。 */
export async function listAliasesByEntityIds(
  db: DbLike,
  entityIds: readonly string[],
): Promise<EntityAlias[]> {
  if (entityIds.length === 0) return [];
  const idList = sql.join(
    entityIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await db.all(
    sql`SELECT * FROM entity_aliases WHERE entity_id IN (${idList})
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToEntityAlias);
}

/** エンティティ+別名セット (言及検出・プロンプト用)。 */
export async function listEntitiesWithAliasesByWork(
  db: DbLike,
  workId: string,
): Promise<EntityWithAliases[]> {
  const entities = await listEntitiesByWork(db, workId);
  const aliases = await listAliasesByEntityIds(
    db,
    entities.map((e) => e.entity_id),
  );
  const byEntity = new Map<string, string[]>();
  for (const a of aliases) {
    const list = byEntity.get(a.entity_id) ?? [];
    list.push(a.alias);
    byEntity.set(a.entity_id, list);
  }
  return entities.map((e) =>
    EntityWithAliasesSchema.parse({ ...e, aliases: byEntity.get(e.entity_id) ?? [] }),
  );
}

/** fact_ref → entity_id リンクの参照 (fact_entities)。 */
export async function listEntityIdsByFactRefs(
  db: DbLike,
  factRefs: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (factRefs.length === 0) return map;
  const refList = sql.join(
    factRefs.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await db.all(
    sql`SELECT fact_ref, entity_id FROM fact_entities
        WHERE fact_ref IN (${refList})`,
  )) as Row[];
  for (const r of rows) {
    const key = String(r.fact_ref);
    const list = map.get(key) ?? [];
    list.push(String(r.entity_id));
    map.set(key, list);
  }
  return map;
}

/** entity_id → fact_ref リンクの参照 (影響分析「その entity を参照する正典」)。 */
export async function listFactRefsByEntityIds(
  db: DbLike,
  entityIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (entityIds.length === 0) return map;
  const idList = sql.join(
    entityIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await db.all(
    sql`SELECT fact_ref, entity_id FROM fact_entities
        WHERE entity_id IN (${idList})`,
  )) as Row[];
  for (const r of rows) {
    const key = String(r.entity_id);
    const list = map.get(key) ?? [];
    list.push(String(r.fact_ref));
    map.set(key, list);
  }
  return map;
}

/** fact_ref のエンティティリンクを全置換する。 */
export async function setFactEntityLinks(
  db: DbLike,
  factRef: string,
  entityIds: readonly string[],
): Promise<void> {
  await db.run(sql`DELETE FROM fact_entities WHERE fact_ref = ${factRef}`);
  for (const entityId of entityIds) {
    await db.run(sql`
      INSERT INTO fact_entities (fact_ref, entity_id, created_at)
      VALUES (${factRef}, ${entityId}, ${now()})
      ON CONFLICT DO NOTHING
    `);
  }
}

/** fact_id (行id) または fact_ref から fact_ref を解決する。 */
export async function resolveFactRef(
  db: DbLike,
  workId: string,
  idOrRef: string,
): Promise<string | null> {
  const r = (await db.get(
    sql`SELECT id, fact_ref FROM canon_facts
        WHERE work_id = ${workId} AND (id = ${idOrRef} OR fact_ref = ${idOrRef})
        ORDER BY (valid_to_rev IS NULL) DESC LIMIT 1`,
  )) as Row | undefined;
  if (!r) return null;
  return (r.fact_ref as string | null) ?? (r.id as string);
}

/** 現行の知識イベント (valid_to_rev IS NULL)。 */
export async function listKnowledgeEventsByWork(
  db: DbLike,
  workId: string,
): Promise<KnowledgeEvent[]> {
  const rows = (await db.all(
    sql`SELECT * FROM knowledge_events WHERE work_id = ${workId}
        AND valid_to_rev IS NULL
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToKnowledgeEvent);
}

/** ある人物 (entity_id) が知っている現行イベント。 */
export async function listKnowledgeEventsByEntity(
  db: DbLike,
  entityId: string,
): Promise<KnowledgeEvent[]> {
  const rows = (await db.all(
    sql`SELECT * FROM knowledge_events WHERE entity_id = ${entityId}
        AND valid_to_rev IS NULL
        ORDER BY created_at ASC, id ASC`,
  )) as Row[];
  return rows.map(rowToKnowledgeEvent);
}

export async function getKnowledgeEventById(
  db: DbLike,
  id: string,
): Promise<KnowledgeEvent | null> {
  const r = (await db.get(
    sql`SELECT * FROM knowledge_events WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToKnowledgeEvent(r) : null;
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
    force_reason: r.force_reason ?? null,
    base_rev: r.base_rev ?? null,
    message_id: r.message_id ?? null,
    prev_settings:
      r.prev_settings == null ? null : JSON.parse(String(r.prev_settings)),
    pre_apply_check:
      r.pre_apply_check == null
        ? null
        : JSON.parse(String(r.pre_apply_check)),
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
    /** 提案時点の works.canon_rev (spec §8.3 楽観的競合検出用)。 */
    baseRev?: number | null;
    messageId?: string | null;
    decidedAt?: number | null;
    appliedAt?: number | null;
  },
): Promise<ChangeSet> {
  const id = crypto.randomUUID();
  const rows = (await db.all(sql`
    INSERT INTO change_sets
      (id, work_id, kind, title, description, ops, status, impact, force,
       base_rev, message_id, created_at, decided_at, applied_at)
    VALUES (${id}, ${input.workId}, ${input.kind ?? "normal"},
            ${input.title}, ${input.description ?? ""},
            ${JSON.stringify(input.ops)}, ${input.status ?? "proposed"},
            ${JSON.stringify(input.impact)}, ${input.force ?? 0},
            ${input.baseRev ?? null},
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
    forceReason?: string | null | undefined;
    /** 適用前の works.charter/policy スナップショット (JSON 文字列)。 */
    prevSettings?: string | null | undefined;
    /** 適用前検査の結果 (JSON 文字列)。 */
    preApplyCheck?: string | null | undefined;
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
      force_reason = ${input.forceReason === undefined ? cur.force_reason : input.forceReason},
      prev_settings = ${input.prevSettings === undefined ? (cur.prev_settings === null ? null : JSON.stringify(cur.prev_settings)) : input.prevSettings},
      pre_apply_check = ${input.preApplyCheck === undefined ? (cur.pre_apply_check === null ? null : JSON.stringify(cur.pre_apply_check)) : input.preApplyCheck},
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
  const entities = new Map<
    string,
    { id: string; name: string; reason: string }
  >();

  const edges = await listDependencyEdgesByWork(db, input.workId);
  const currentFacts = await listCanonFactsByWork(db, input.workId);
  const allEntities = await listEntitiesWithAliasesByWork(db, input.workId);
  const entityById = new Map(allEntities.map((e) => [e.entity_id, e]));

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

  // 影響対象のエンティティを1件登録する。
  const addEntity = (entityId: string, reason: string) => {
    const e = entityById.get(entityId);
    if (!e || entities.has(entityId)) return;
    entities.set(entityId, { id: entityId, name: e.name, reason });
  };

  const addScene = async (sceneId: string, reason: string) => {
    if (scenes.has(sceneId)) return;
    const scene = await getSceneById(db, sceneId);
    scenes.set(sceneId, {
      id: sceneId,
      title: scene?.title ?? "(不明なシーン)",
      reason,
    });
  };

  // シーン本文の遅延キャッシュ (言及の副経路走査用)。
  const proseCache = new Map<string, string>();
  const sceneProse = async (sceneId: string): Promise<string> => {
    if (!proseCache.has(sceneId)) {
      const revs = await listRevisionsByScene(db, sceneId);
      const latest = revs.at(-1);
      proseCache.set(
        sceneId,
        latest ? tiptapDocToText(latest.content_json) : "",
      );
    }
    return proseCache.get(sceneId)!;
  };
  let workScenes: Scene[] | null = null;

  /**
   * 「そのエンティティを言及するシーン」の副経路 (spec §6.6):
   * dependency_edges の言及エッジ (target_kind="mention", target_ref=entity_id)
   * + エッジ未記録のシーンは本文をエイリアス辞書でその場走査する。
   */
  const scenesMentioning = async (entityId: string, reason: string) => {
    const e = entityById.get(entityId);
    if (!e) return;
    let usedEdge = false;
    for (const edge of edges) {
      if (edge.target_kind === "mention" && edge.target_ref === entityId) {
        usedEdge = true;
        await addScene(edge.scene_id, reason);
      }
    }
    if (usedEdge) return;
    workScenes ??= await listScenesByWork(db, input.workId);
    for (const scene of workScenes) {
      const prose = await sceneProse(scene.id);
      if (!prose) continue;
      const mentions = detectEntityMentions(prose, [
        { id: e.entity_id, name: e.name, aliases: e.aliases },
      ]);
      if (mentions.length > 0) await addScene(scene.id, reason);
    }
  };

  /** 正典の依存宣言先シーンを登録する (依存エッジ経路)。 */
  const scenesDependingOnFact = async (fact: CanonFact, _reason: string) => {
    for (const edge of edges) {
      if (edge.target_kind !== "canon_fact") continue;
      if (
        edge.target_ref === fact.id ||
        edge.target_ref === (fact.fact_ref ?? "") ||
        statementsMatch(edge.target_ref, fact.statement)
      ) {
        await addScene(edge.scene_id, `依存宣言「${edge.target_ref}」`);
      }
    }
  };

  /**
   * エンティティを影響対象に据えたときの共通展開: その entity を参照する
   * 現行正典 + その正典に依存/言及するシーン (spec §6.4 影響分析)。
   */
  const expandEntityImpact = async (entityId: string) => {
    const linked = await listFactRefsByEntityIds(db, [entityId]);
    const refs = linked.get(entityId) ?? [];
    for (const fact of currentFacts) {
      const ref = fact.fact_ref ?? fact.id;
      if (!refs.includes(ref)) continue;
      if (!facts.has(fact.id)) {
        facts.set(fact.id, {
          id: fact.id,
          statement: fact.statement,
          reason: "影響する登場要素に紐付く正典",
        });
      }
      await scenesDependingOnFact(
        fact,
        `登場要素に紐付く正典「${fact.statement}」の依存`,
      );
    }
    await scenesMentioning(entityId, `登場要素「${entityById.get(entityId)?.name ?? entityId}」への言及`);
  };

  /** fact 経路で繋がるエンティティを拾い、その言及シーンも影響に入れる。 */
  const expandFactEntityPaths = async (fact: CanonFact) => {
    const linked = await listEntityIdsByFactRefs(db, [fact.fact_ref ?? fact.id]);
    const ids = linked.get(fact.fact_ref ?? fact.id) ?? [];
    for (const entityId of ids) {
      addEntity(entityId, "変更対象の正典に紐付く登場要素");
      await scenesMentioning(
        entityId,
        `正典変更に紐付く登場要素「${entityById.get(entityId)?.name ?? entityId}」への言及`,
      );
    }
  };

  for (const op of input.ops) {
    if (
      op.op === "retire_fact" ||
      op.op === "revise_fact" ||
      op.op === "set_fact_commitment"
    ) {
      const fact = await getCanonFactById(db, op.fact_id);
      if (!fact) continue;
      // 依存宣言で繋がる scenes
      await scenesDependingOnFact(fact, "依存宣言");
      // その fact の entity_refs に繋がる登場要素を言及するシーン (副経路)
      await expandFactEntityPaths(fact);
      // 文面が近い他の現行正典 (確度変更は文面を変えないので対象外)
      if (op.op === "set_fact_commitment") continue;
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
    } else if (op.op === "rewrite_scene") {
      // 本文書き換えは対象シーン自身が影響対象 (依存先の再検査はレビューに委ねる)
      if (!scenes.has(op.scene_id)) {
        const scene = await getSceneById(db, op.scene_id);
        scenes.set(op.scene_id, {
          id: op.scene_id,
          title: scene?.title ?? "(不明なシーン)",
          reason: "本文の書き換え対象",
        });
      }
    } else if (op.op === "add_entity") {
      // 新規エンティティはまだ参照を持たないので impact には出さない
      // (同名の既存エンティティがあればそれが影響対象)。
      const dup = allEntities.find(
        (e) => e.kind === op.kind && e.name === op.name,
      );
      if (dup) addEntity(dup.entity_id, "同名同種の既存登場要素");
    } else if (op.op === "update_entity" || op.op === "retire_entity") {
      const entity = entityById.get(op.entity_id);
      addEntity(
        op.entity_id,
        op.op === "update_entity" ? "登場要素の更新対象" : "登場要素の廃止対象",
      );
      if (entity) await expandEntityImpact(op.entity_id);
    } else if (
      op.op === "add_knowledge_event" ||
      op.op === "retract_knowledge_event"
    ) {
      // 知識イベントは対象 fact/entity と同じ経路を影響に含める。
      let entityId: string | null = null;
      let factIdOrRef: string | null = null;
      if (op.op === "add_knowledge_event") {
        entityId = op.entity_id;
        factIdOrRef = op.fact_id;
      } else {
        const ev = await getKnowledgeEventById(db, op.event_id);
        if (ev) {
          entityId = ev.entity_id;
          factIdOrRef = ev.fact_id;
        }
      }
      if (entityId) {
        addEntity(entityId, "知識イベントの対象人物");
        await expandEntityImpact(entityId);
      }
      if (factIdOrRef) {
        const factRef = await resolveFactRef(db, input.workId, factIdOrRef);
        const fact = currentFacts.find(
          (f) => (f.fact_ref ?? f.id) === factRef || f.id === factIdOrRef,
        );
        if (fact) {
          if (!facts.has(fact.id)) {
            facts.set(fact.id, {
              id: fact.id,
              statement: fact.statement,
              reason: "知識イベントの対象正典",
            });
          }
          await scenesDependingOnFact(fact, "知識イベント対象正典の依存");
          await expandFactEntityPaths(fact);
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
  if (entities.size > 0) parts.push(`登場要素 ${entities.size} 件`);
  const summary =
    parts.length > 0
      ? `${parts.join("・")}に影響する可能性`
      : "影響対象は見つかりませんでした";

  return {
    scenes: [...scenes.values()],
    facts: [...facts.values()],
    contracts: [...contracts.values()],
    entities: [...entities.values()],
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
    entities: [],
    summary: "手編集による本文の変更",
  };
}

// --- 適用前検証 (spec §5.3 step 6-8: verify-then-commit) ---
//
// D1 は単一ストアで「一時ブランチに適用して検査」はできないため、
// 通常承認の直前に同期で走らせる検査として実装する。実行するのは
// 決定的に検査できるものだけ (spec §10) — 文意の矛盾は適用後の
// review_change に委ねる。
// - 影響再計算: 提案時の impact と今の computeChangeSetImpact を比較し、
//   新たに影響に入ったシーン/正典を warnings に出す (拡大だけ。縮小は
//   安全側の変化なので黙る)。
// - ops の構造検証: 参照先 (scene_id / fact_id) の存在と、fact ops の
//   対象がまだ現行 (valid_to_rev 未設定) かを見る。
// - 本文 ops の決定的検査: rewrite_scene は対象シーンの最新契約に対して
//   checkForbidden / checkRequiredEvents を実行し、info 以外の検出を
//   violations とする (info はヒューリスティック未検出なので warnings)。
// 結果は change_sets.pre_apply_check に毎回記録する。

export async function verifyChangeSetForApply(
  db: DbLike,
  input: { changeSetId: string },
): Promise<PreApplyCheck | null> {
  const cs = await getChangeSetById(db, input.changeSetId);
  if (!cs) return null;
  const warnings: PreApplyCheckItem[] = [];
  const violations: PreApplyCheckItem[] = [];

  // (a) 影響再計算: 提案時に記録した impact と現在の計算を突き合わせ、
  // 新たに影響に入ったエンティティを警告する。
  const current = await computeChangeSetImpact(db, {
    workId: cs.work_id,
    ops: cs.ops,
  });
  const recordedScenes = new Set(cs.impact.scenes.map((s) => s.id));
  for (const s of current.scenes) {
    if (!recordedScenes.has(s.id)) {
      warnings.push({
        kind: "impact_grew",
        detail: `シーン「${s.title}」が新たに影響対象に入りました (${s.reason})`,
      });
    }
  }
  const recordedFacts = new Set(cs.impact.facts.map((f) => f.id));
  for (const f of current.facts) {
    if (!recordedFacts.has(f.id)) {
      warnings.push({
        kind: "impact_grew",
        detail: `正典「${f.statement}」が新たに影響対象に入りました (${f.reason})`,
      });
    }
  }
  const recordedEntities = new Set(
    (cs.impact.entities ?? []).map((e) => e.id),
  );
  for (const e of current.entities) {
    if (!recordedEntities.has(e.id)) {
      warnings.push({
        kind: "impact_grew",
        detail: `登場要素「${e.name}」が新たに影響対象に入りました (${e.reason})`,
      });
    }
  }

  // (b) ops の構造検証: 参照先の存在と、fact ops の対象の現行性。
  const sceneCache = new Map<string, Scene | null>();
  const sceneOf = async (id: string) => {
    if (!sceneCache.has(id)) sceneCache.set(id, await getSceneById(db, id));
    return sceneCache.get(id)!;
  };
  for (const op of cs.ops) {
    if (op.op === "retire_fact" || op.op === "revise_fact") {
      const fact = await getCanonFactById(db, op.fact_id);
      const opLabel = op.op === "retire_fact" ? "廃止" : "改定";
      if (!fact || fact.work_id !== cs.work_id) {
        violations.push({
          kind: "missing_ref",
          detail: `${opLabel}対象の正典が見つかりません (fact_id=${op.fact_id})。すでに整理された可能性があります`,
        });
      } else if (fact.valid_to_rev !== null) {
        violations.push({
          kind: "stale_fact",
          detail: `${opLabel}対象の正典「${fact.statement}」は rev${fact.valid_to_rev} で既に閉じられています。別の変更と重なっているため内容を見直してください`,
        });
      }
    } else if (op.op === "rewrite_scene") {
      const scene = await sceneOf(op.scene_id);
      if (!scene) {
        violations.push({
          kind: "missing_ref",
          detail: `書き換え対象のシーンが見つかりません (scene_id=${op.scene_id})。シーンが削除・再構成された可能性があります`,
        });
      }
    } else if (op.op === "update_entity" || op.op === "retire_entity") {
      const entity = await getCurrentEntityByEntityId(db, op.entity_id);
      if (!entity || entity.work_id !== cs.work_id) {
        violations.push({
          kind: "missing_ref",
          detail: `対象の登場要素が見つかりません (entity_id=${op.entity_id})。既に廃止された可能性があります`,
        });
      }
    } else if (op.op === "add_knowledge_event") {
      const entity = await getCurrentEntityByEntityId(db, op.entity_id);
      if (!entity || entity.work_id !== cs.work_id) {
        violations.push({
          kind: "missing_ref",
          detail: `知識イベントの対象人物が見つかりません (entity_id=${op.entity_id})`,
        });
      }
      const factRef = await resolveFactRef(db, cs.work_id, op.fact_id);
      if (!factRef) {
        violations.push({
          kind: "missing_ref",
          detail: `知識イベントの対象正典が見つかりません (fact_id=${op.fact_id})`,
        });
      }
      if (op.scene_id !== undefined) {
        const scene = await sceneOf(op.scene_id);
        if (!scene) {
          warnings.push({
            kind: "missing_ref",
            detail: `知識イベントの起点シーンが見つかりません (scene_id=${op.scene_id})。scene_id なしで記録されます`,
          });
        }
      }
    } else if (op.op === "retract_knowledge_event") {
      const ev = await getKnowledgeEventById(db, op.event_id);
      if (!ev || ev.work_id !== cs.work_id) {
        violations.push({
          kind: "missing_ref",
          detail: `取消対象の知識イベントが見つかりません (event_id=${op.event_id})`,
        });
      } else if (ev.valid_to_rev !== null) {
        violations.push({
          kind: "stale_fact",
          detail: `取消対象の知識イベントは rev${ev.valid_to_rev} で既に閉じられています`,
        });
      }
    }
    // fact 系 ops の entity_refs: 参照する登場要素が現行であること。
    if (
      (op.op === "add_fact" || op.op === "revise_fact") &&
      op.entity_refs !== undefined
    ) {
      for (const entityId of op.entity_refs) {
        const entity = await getCurrentEntityByEntityId(db, entityId);
        if (!entity || entity.work_id !== cs.work_id) {
          violations.push({
            kind: "missing_ref",
            detail: `正典に紐付ける登場要素が見つかりません (entity_id=${entityId})`,
          });
        }
      }
    }
    // add_fact / update_work は参照先を持たないので検査対象なし。
  }

  // (c) 本文 ops の決定的検査: rewrite_scene は対象シーンの最新契約に
  // 対して checkForbidden / checkRequiredEvents を実行する。
  for (const op of cs.ops) {
    if (op.op !== "rewrite_scene") continue;
    const scene = await sceneOf(op.scene_id);
    if (!scene) continue; // 参照先消失は (b) で違反済み
    const contract = await getLatestContractByScene(db, op.scene_id);
    if (!contract) {
      warnings.push({
        kind: "contract_check",
        detail: `シーン「${scene.title}」に執筆契約が無いため、本文の決定的検査をスキップしました`,
      });
      continue;
    }
    const reports = [
      checkForbidden(op.text, contract.payload),
      checkRequiredEvents(op.text, contract.payload),
    ];
    for (const f of reports.flatMap((r) => r.findings)) {
      const entry = {
        kind: f.severity === "info" ? "contract_check" : "contract_violation",
        detail: `シーン「${scene.title}」: ${f.detail}`,
      };
      if (f.severity === "info") warnings.push(entry);
      else violations.push(entry);
    }
  }

  const check: PreApplyCheck = {
    checked_at: now(),
    warnings,
    violations,
  };
  await updateChangeSetState(db, {
    id: cs.id,
    preApplyCheck: JSON.stringify(check),
  });
  return check;
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
    commitment: string;
    disclosure: string;
    provenance: string;
    validFromRev: number;
    /** 改定元の安定ID。省略時は新しい行の id が fact_ref になる。 */
    factRef?: string | undefined;
  },
): Promise<{ id: string; factRef: string } | null> {
  const id = crypto.randomUUID();
  const factRef = input.factRef ?? id;
  const rows = (await db.all(sql`
    INSERT INTO canon_facts
      (id, work_id, statement, commitment, disclosure, provenance,
       valid_from_rev, valid_to_rev, fact_ref, created_at)
    VALUES (${id}, ${input.workId}, ${input.statement},
            ${input.commitment}, ${input.disclosure},
            ${input.provenance}, ${input.validFromRev}, NULL,
            ${factRef}, ${now()})
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as Row[];
  if (rows.length > 0) return { id, factRef };
  // 文面の完全一致で挿入がスキップされた場合は現行行を引いて返す。
  const existing = (await db.get(
    sql`SELECT id, fact_ref FROM canon_facts
        WHERE work_id = ${input.workId} AND statement = ${input.statement}
          AND valid_to_rev IS NULL`,
  )) as Row | undefined;
  if (!existing) return null;
  return {
    id: existing.id as string,
    factRef: (existing.fact_ref as string | null) ?? (existing.id as string),
  };
}

/** 正典のエンティティリンクを全置換 (entity_refs 指定時)。 */
async function applyFactEntityRefs(
  db: DbLike,
  factRef: string,
  entityRefs: readonly string[] | undefined,
): Promise<void> {
  if (entityRefs === undefined) return;
  const dedup = [...new Set(entityRefs)];
  await setFactEntityLinks(db, factRef, dedup);
}

/** add_entity: 新行を挿入 (同 kind+name の現行行があるときは別名だけ吸収する)。 */
async function applyAddEntity(
  db: DbLike,
  input: {
    workId: string;
    op: Extract<ChangeSetOp, { op: "add_entity" }>;
    newRev: number;
  },
): Promise<void> {
  const entityId = crypto.randomUUID();
  await db.run(sql`
    INSERT INTO story_entities
      (id, entity_id, work_id, kind, name, summary,
       valid_from_rev, valid_to_rev, created_at)
    VALUES (${crypto.randomUUID()}, ${entityId}, ${input.workId},
            ${input.op.kind}, ${input.op.name}, ${input.op.summary},
            ${input.newRev}, NULL, ${now()})
    ON CONFLICT DO NOTHING
  `);
  // 同名同種の現行行が既にあった場合はその entity_id に別名を寄せる。
  const row = (await db.get(
    sql`SELECT entity_id FROM story_entities
        WHERE work_id = ${input.workId} AND kind = ${input.op.kind}
          AND name = ${input.op.name} AND valid_to_rev IS NULL`,
  )) as Row | undefined;
  if (!row) return;
  const targetId = row.entity_id as string;
  for (const alias of new Set(input.op.aliases)) {
    await db.run(sql`
      INSERT INTO entity_aliases (id, entity_id, alias, created_at)
      VALUES (${crypto.randomUUID()}, ${targetId}, ${alias}, ${now()})
      ON CONFLICT DO NOTHING
    `);
  }
}

/** update_entity: 旧行を閉じて新行を挿入 (時系列。entity_id は引き継ぐ)。 */
async function applyUpdateEntity(
  db: DbLike,
  input: {
    workId: string;
    op: Extract<ChangeSetOp, { op: "update_entity" }>;
    newRev: number;
  },
): Promise<void> {
  const old = await getCurrentEntityByEntityId(db, input.op.entity_id);
  if (!old || old.work_id !== input.workId) return;
  await db.run(sql`
    UPDATE story_entities SET valid_to_rev = ${input.newRev}
    WHERE entity_id = ${old.entity_id} AND valid_to_rev IS NULL
  `);
  await db.run(sql`
    INSERT INTO story_entities
      (id, entity_id, work_id, kind, name, summary,
       valid_from_rev, valid_to_rev, created_at)
    VALUES (${crypto.randomUUID()}, ${old.entity_id}, ${input.workId},
            ${old.kind}, ${input.op.name ?? old.name},
            ${input.op.summary ?? old.summary},
            ${input.newRev}, NULL, ${now()})
    ON CONFLICT DO NOTHING
  `);
  for (const alias of new Set(input.op.add_aliases ?? [])) {
    await db.run(sql`
      INSERT INTO entity_aliases (id, entity_id, alias, created_at)
      VALUES (${crypto.randomUUID()}, ${old.entity_id}, ${alias}, ${now()})
      ON CONFLICT DO NOTHING
    `);
  }
  for (const alias of new Set(input.op.remove_aliases ?? [])) {
    await db.run(sql`
      DELETE FROM entity_aliases
      WHERE entity_id = ${old.entity_id} AND alias = ${alias}
    `);
  }
}

/**
 * add_knowledge_event: fact_id は行 id / fact_ref どちらでも受け、
 * fact_ref に解決して記録する (spec §6.4)。同人物×同事実の現行イベントが
 * 既にある場合は重複記録しない。
 */
async function applyAddKnowledgeEvent(
  db: DbLike,
  input: {
    workId: string;
    op: Extract<ChangeSetOp, { op: "add_knowledge_event" }>;
    newRev: number;
  },
): Promise<void> {
  const factRef = await resolveFactRef(db, input.workId, input.op.fact_id);
  if (!factRef) return;
  const entity = await getCurrentEntityByEntityId(db, input.op.entity_id);
  if (!entity || entity.work_id !== input.workId) return;
  const dup = (await db.get(
    sql`SELECT id FROM knowledge_events
        WHERE entity_id = ${input.op.entity_id} AND fact_id = ${factRef}
          AND valid_to_rev IS NULL`,
  )) as Row | undefined;
  if (dup) return;
  await db.run(sql`
    INSERT INTO knowledge_events
      (id, work_id, entity_id, fact_id, scene_id, source,
       valid_from_rev, valid_to_rev, created_at)
    VALUES (${crypto.randomUUID()}, ${input.workId}, ${input.op.entity_id},
            ${factRef}, ${input.op.scene_id ?? null}, ${input.op.source},
            ${input.newRev}, NULL, ${now()})
  `);
}

/**
 * 変更セットの ops を適用し、works.canon_rev を +1 する (spec §5.3)。
 * - retire_fact: valid_to_rev を新 rev に設定して閉じる
 * - revise_fact: 旧行を閉じ、新行を valid_from_rev=新 rev で挿入
 * - add_fact: 新行を挿入
 * - entity 系: add/update/retire (時系列モデル) + fact_entities リンク
 * - knowledge_event 系: 誰が何を知ったかの記録/取消
 * - update_work: works の構造情報をパッチ
 * force=true のとき kind=force_override に昇格する (spec §5.4)。
 * 適用済みの変更セットは冪等に現状を返す。
 */
export async function applyChangeSet(
  db: DbLike,
  input: { changeSetId: string; force?: boolean; reason?: string | null | undefined },
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
  // 楽観的競合 (spec §8.3): 提案時点から正典が変わっていたら通常承認は
  // 拒否する。正典に触れる ops (fact 系) を含む提案だけを対象にする
  // (update_work だけの提案が毎回 force を要求されるのを防ぐ)。
  const touchesCanon = cs.ops.some(
    (op) => op.op !== "update_work" && op.op !== "rewrite_scene",
  );
  if (
    !input.force &&
    touchesCanon &&
    cs.base_rev !== null &&
    cs.base_rev !== work.canon_rev
  ) {
    throw new RepoError(
      "conflict",
      "提案された時点から正典が変更されています。内容を確認してから「強制的に変更」で適用してください",
    );
  }
  const newRev = work.canon_rev + 1;
  const provenance = `change_set:${cs.id}`;

  for (const op of cs.ops) {
    if (op.op === "retire_fact") {
      await closeCanonFact(db, { factId: op.fact_id, validToRev: newRev });
    } else if (op.op === "revise_fact") {
      const old = await getCanonFactById(db, op.fact_id);
      const closed = await closeCanonFact(db, {
        factId: op.fact_id,
        validToRev: newRev,
      });
      if (closed) {
        const inserted = await insertCanonFactRev(db, {
          workId: cs.work_id,
          statement: op.new_statement,
          // commitment/disclosure もリビジョンの一部: 指定がなければ旧行を引き継ぐ
          commitment: op.commitment ?? old?.commitment ?? "fixed",
          disclosure: op.disclosure ?? old?.disclosure ?? "normal",
          provenance,
          validFromRev: newRev,
          // 安定IDを引き継ぐので、旧行へのエンティティリンク・知識
          // イベントはそのまま新しい文面を指し続ける (spec §6.4)。
          factRef: old?.fact_ref ?? old?.id,
        });
        if (inserted && op.entity_refs !== undefined) {
          await applyFactEntityRefs(db, inserted.factRef, op.entity_refs);
        }
      }
    } else if (op.op === "add_fact") {
      const inserted = await insertCanonFactRev(db, {
        workId: cs.work_id,
        statement: op.statement,
        commitment: op.commitment ?? "fixed",
        disclosure: op.disclosure ?? "normal",
        provenance,
        validFromRev: newRev,
      });
      if (inserted && op.entity_refs !== undefined) {
        await applyFactEntityRefs(db, inserted.factRef, op.entity_refs);
      }
    } else if (op.op === "set_fact_commitment") {
      // 確度/開示の変更もリビジョンとして記録する (旧行を閉じて新行を挿入)
      const old = await getCanonFactById(db, op.fact_id);
      const closed = await closeCanonFact(db, {
        factId: op.fact_id,
        validToRev: newRev,
      });
      if (closed && old) {
        await insertCanonFactRev(db, {
          workId: cs.work_id,
          statement: old.statement,
          commitment: op.commitment,
          disclosure: op.disclosure ?? old.disclosure,
          provenance,
          validFromRev: newRev,
          factRef: old.fact_ref ?? old.id,
        });
      }
    } else if (op.op === "add_entity") {
      await applyAddEntity(db, { workId: cs.work_id, op, newRev });
    } else if (op.op === "update_entity") {
      await applyUpdateEntity(db, { workId: cs.work_id, op, newRev });
    } else if (op.op === "retire_entity") {
      await db.run(sql`
        UPDATE story_entities SET valid_to_rev = ${newRev}
        WHERE entity_id = ${op.entity_id} AND work_id = ${cs.work_id}
          AND valid_to_rev IS NULL
      `);
    } else if (op.op === "add_knowledge_event") {
      await applyAddKnowledgeEvent(db, {
        workId: cs.work_id,
        op,
        newRev,
      });
    } else if (op.op === "retract_knowledge_event") {
      await db.run(sql`
        UPDATE knowledge_events SET valid_to_rev = ${newRev}
        WHERE id = ${op.event_id} AND work_id = ${cs.work_id}
          AND valid_to_rev IS NULL
      `);
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
    } else if (op.op === "rewrite_scene") {
      // 本文書き換えは新リビジョンとして適用 (change_set_id 紐付き)。
      // シーンが消えていればスキップする (適用自体は止めない)。
      const scene = await getSceneById(db, op.scene_id);
      if (scene) {
        await createSceneRevision(db, {
          sceneId: op.scene_id,
          contentJson: textToTiptapDoc(op.text),
          source: "ai",
          changeSetId: cs.id,
        });
        if (scene.status !== "generated") {
          await updateSceneStatus(db, { id: op.scene_id, status: "generated" });
        }
      }
    }
  }

  await db.run(sql`
    UPDATE works SET canon_rev = ${newRev}, updated_at = ${now()}
    WHERE id = ${cs.work_id}
  `);
  const kind = input.force ? "force_override" : cs.kind;
  // charter/policy を変える update_work op がある時は、適用前の値を
  // change_sets.prev_settings に退避する (docs/gaps.md「変更前
  // スナップショットの保持」。canon_facts とは別に作品設定も残す)。
  const keepsPrevSettings = cs.ops.some(
    (op) =>
      op.op === "update_work" &&
      (op.patch.charter !== undefined || op.patch.policy !== undefined),
  );
  const updated = await updateChangeSetState(db, {
    id: cs.id,
    status: "applied",
    kind,
    force: input.force ? 1 : cs.force,
    forceReason: input.force ? (input.reason ?? null) : undefined,
    prevSettings: keepsPrevSettings
      ? JSON.stringify({ charter: work.charter, policy: work.policy })
      : undefined,
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

// ---------------------------------------------------------------------------
// Phase 3a: 公開リリース (spec §6 Release, P9)
// ---------------------------------------------------------------------------

function rowToRelease(r: Row): Release {
  return ReleaseSchema.parse({
    id: r.id,
    work_id: r.work_id,
    episode_id: r.episode_id,
    rev_no: r.rev_no,
    canon_rev: r.canon_rev,
    title: r.title,
    content: JSON.parse(String(r.content_json)),
    status: ReleaseStatusSchema.parse(r.status),
    published_at: r.published_at,
    created_at: r.created_at,
  });
}

/**
 * 話の現在本文をスナップショット用に組み立てる。
 * 各シーンの最新リビジョンを tiptap→text にして順に並べる。
 * 本文リビジョンが無いシーンは含めない。
 */
export async function snapshotEpisodeProse(
  db: DbLike,
  episodeId: string,
): Promise<ReleaseScene[]> {
  const sceneRows = await listScenesByEpisode(db, episodeId);
  const scenes: ReleaseScene[] = [];
  for (const scene of sceneRows) {
    const revs = await listRevisionsByScene(db, scene.id);
    const latest = revs.at(-1);
    if (!latest) continue;
    scenes.push({
      scene_ord: scene.ord,
      scene_title: scene.title,
      prose_md: tiptapDocToText(latest.content_json),
    });
  }
  return scenes;
}

/** リリースを発行する。rev_no = その話の既存最大+1 (ユニーク制約)。 */
export async function createRelease(
  db: DbLike,
  input: {
    workId: string;
    episodeId: string;
    title: string;
    canonRev: number;
    content: ReleaseScene[];
  },
): Promise<Release> {
  const t = now();
  const rows = (await db.all(sql`
    INSERT INTO releases (id, work_id, episode_id, rev_no, canon_rev, title, content_json, status, published_at, created_at)
    VALUES (${crypto.randomUUID()}, ${input.workId}, ${input.episodeId},
            (SELECT COALESCE(MAX(rev_no), 0) + 1 FROM releases WHERE episode_id = ${input.episodeId}),
            ${input.canonRev}, ${input.title}, ${JSON.stringify(input.content)},
            'published', ${t}, ${t})
    RETURNING *
  `)) as Row[];
  return rowToRelease(rows[0]!);
}

export async function getReleaseById(
  db: DbLike,
  id: string,
): Promise<Release | null> {
  const r = (await db.get(
    sql`SELECT * FROM releases WHERE id = ${id}`,
  )) as Row | undefined;
  return r ? rowToRelease(r) : null;
}

export async function listReleasesByWork(
  db: DbLike,
  workId: string,
): Promise<Release[]> {
  const rows = (await db.all(
    sql`SELECT r.* FROM releases r
        JOIN episodes e ON e.id = r.episode_id
        WHERE r.work_id = ${workId}
        ORDER BY e.ord ASC, r.rev_no ASC`,
  )) as Row[];
  return rows.map(rowToRelease);
}

export async function setReleaseStatus(
  db: DbLike,
  input: { id: string; status: "published" | "unlisted" },
): Promise<Release | null> {
  const rows = (await db.all(sql`
    UPDATE releases SET status = ${input.status}
    WHERE id = ${input.id}
    RETURNING *
  `)) as Row[];
  return rows.length > 0 ? rowToRelease(rows[0]!) : null;
}

/**
 * /w/:id 用の公開目次: 話ごとの最新 published リリースと版数 (話順)。
 * published が 1 件も無い話は含めない。正典・下書き・ユーザー情報は
 * 返さない (spec P9)。
 */
export async function listPublicWorkEpisodes(
  db: DbLike,
  workId: string,
): Promise<PublicWorkEpisode[]> {
  const [episodes, releases] = await Promise.all([
    listEpisodesByWork(db, workId),
    listReleasesByWork(db, workId),
  ]);
  const publishedByEpisode = new Map<string, Release[]>();
  for (const r of releases) {
    if (r.status !== "published") continue;
    const list = publishedByEpisode.get(r.episode_id) ?? [];
    list.push(r);
    publishedByEpisode.set(r.episode_id, list);
  }
  const rows: PublicWorkEpisode[] = [];
  for (const ep of episodes) {
    const rels = publishedByEpisode.get(ep.id);
    if (!rels || rels.length === 0) continue;
    // listReleasesByWork は rev_no 昇順なので末尾が最新版
    const latest = rels.at(-1)!;
    rows.push({
      episode_id: ep.id,
      ord: ep.ord,
      title: latest.title,
      version_count: rels.length,
      release_id: latest.id,
      rev_no: latest.rev_no,
      published_at: latest.published_at,
    });
  }
  return rows;
}
