import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * D1 (SQLite) スキーマ定義。drizzle-kit generate で migrations/*.sql を作る。
 * JSON 値 (payload/result/data) は TEXT にシリアライズして保存する。
 */
export const agentJobs = sqliteTable(
  "agent_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    workRef: text("work_ref"),
    /** ジョブを起こしたユーザー (users.id)。実行体経由ジョブは NULL。 */
    userRef: text("user_ref"),
    payload: text("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("queued"),
    leasedBy: text("leased_by"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    attempts: integer("attempts").notNull().default(0),
    result: text("result"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("agent_jobs_idempotency_key_uq").on(t.idempotencyKey),
    index("agent_jobs_queue_idx").on(t.status, t.createdAt),
    index("agent_jobs_lease_idx").on(t.status, t.leaseExpiresAt),
  ],
);

export const progressEvents = sqliteTable(
  "progress_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("progress_events_job_seq_uq").on(t.jobId, t.seq),
    index("progress_events_job_idx").on(t.jobId),
  ],
);

export const providerKeys = sqliteTable("provider_keys", {
  id: text("id").primaryKey(),
  ownerRef: text("owner_ref").notNull(),
  label: text("label").notNull(),
  provider: text("provider").notNull().default("openai"),
  ciphertext: text("ciphertext").notNull(),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Phase 1a: 作品・対話
// ---------------------------------------------------------------------------

export const works = sqliteTable(
  "works",
  {
    id: text("id").primaryKey(),
    ownerRef: text("owner_ref").notNull(),
    title: text("title").notNull(),
    premise: text("premise").notNull().default(""),
    genre: text("genre").notNull().default(""),
    status: text("status").notNull().default("setup"),
    /** StoryCharter / NarrativePolicy JSON (未作成は NULL)。 */
    charterJson: text("charter_json"),
    policyJson: text("policy_json"),
    /** 作品の既定プロバイダー/モデル/キー (未設定は NULL)。 */
    provider: text("provider"),
    model: text("model"),
    keyRef: text("key_ref"),
    /** 現在の正典リビジョン (spec §6.3。変更セット適用ごとに +1)。 */
    canonRev: integer("canon_rev").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("works_owner_idx").on(t.ownerRef)],
);

export const chatThreads = sqliteTable(
  "chat_threads",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("chat_threads_work_uq").on(t.workId)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** assistant メッセージを生成したジョブ (冪等キー、user 発言は NULL)。 */
    jobId: text("job_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("chat_messages_thread_idx").on(t.threadId, t.createdAt),
    uniqueIndex("chat_messages_job_uq").on(t.jobId),
  ],
);

// ---------------------------------------------------------------------------
// Phase 1b: 話・シーン・Writing Contract・正典メモ・提案
// ---------------------------------------------------------------------------

export const episodes = sqliteTable(
  "episodes",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    ord: integer("ord").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("episodes_work_idx").on(t.workId, t.ord)],
);

export const scenes = sqliteTable(
  "scenes",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull(),
    ord: integer("ord").notNull(),
    title: text("title").notNull(),
    purpose: text("purpose").notNull().default(""),
    /** draft | proposed | approved | generated */
    status: text("status").notNull().default("draft"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("scenes_episode_idx").on(t.episodeId, t.ord)],
);

export const sceneRevisions = sqliteTable(
  "scene_revisions",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id").notNull(),
    revNo: integer("rev_no").notNull(),
    /** Tiptap doc JSON。 */
    contentJson: text("content_json").notNull(),
    /** ai | manual_edit */
    source: text("source").notNull(),
    jobId: text("job_id"),
    /** このリビジョンを記録した変更セット (手編集の紐付け, spec §5.5)。 */
    changeSetId: text("change_set_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("scene_revisions_rev_uq").on(t.sceneId, t.revNo),
    index("scene_revisions_scene_idx").on(t.sceneId),
  ],
);

export const writingContracts = sqliteTable(
  "writing_contracts",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id").notNull(),
    /** draft | approved | rejected */
    status: text("status").notNull().default("draft"),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (t) => [index("writing_contracts_scene_idx").on(t.sceneId)],
);

export const canonFacts = sqliteTable(
  "canon_facts",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    statement: text("statement").notNull(),
    provenance: text("provenance").notNull(),
    /** この行が現行になった正典リビジョン (spec §6.3。無バージョン追加は NULL)。 */
    validFromRev: integer("valid_from_rev"),
    /** 閉じられた正典リビジョン (NULL=現行)。 */
    validToRev: integer("valid_to_rev"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("canon_facts_work_idx").on(t.workId),
    // statement 完全一致の重複を「現行行」のみで防ぐ
    // (閉じた行は同じ statement を再登録できるように partial unique)
    uniqueIndex("canon_facts_work_statement_current_uq")
      .on(t.workId, t.statement)
      .where(sql`valid_to_rev IS NULL`),
  ],
);

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    /** pending | approved | rejected */
    status: text("status").notNull().default("pending"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("proposals_work_idx").on(t.workId),
    index("proposals_thread_idx").on(t.threadId),
    // 同一メッセージからの同種提案の重複作成を防ぐ (orchestrator 再開の冪等)
    uniqueIndex("proposals_message_kind_uq").on(t.messageId, t.kind),
  ],
);

// ---------------------------------------------------------------------------
// Phase 2a: 依存エッジ (spec §6.1/§6.4 DependencyEdge)
// ---------------------------------------------------------------------------

export const dependencyEdges = sqliteTable(
  "dependency_edges",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    sceneId: text("scene_id").notNull(),
    /** 依存先の種別 (canon_fact | plan | scene | contract …)。 */
    targetKind: text("target_kind").notNull(),
    /** 依存先の参照 (宣言側の言い方のまま)。 */
    targetRef: text("target_ref").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("dependency_edges_work_idx").on(t.workId),
    index("dependency_edges_scene_idx").on(t.sceneId),
    // 同じ宣言の重複記録を防ぐ (resume の冪等)
    uniqueIndex("dependency_edges_scene_target_uq").on(
      t.sceneId,
      t.targetKind,
      t.targetRef,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Phase 2b: 変更セット + レビュー所見 (spec §5, §5.5, §6.3)
// ---------------------------------------------------------------------------

export const changeSets = sqliteTable(
  "change_sets",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    /** normal | manual_edit | force_override */
    kind: text("kind").notNull().default("normal"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** ChangeSetOp[] の JSON。 */
    ops: text("ops").notNull(),
    /** proposed | approved | rejected | applied */
    status: text("status").notNull().default("proposed"),
    /** ChangeSetImpact の JSON (作成時に決定的に計算)。 */
    impact: text("impact").notNull(),
    /** 強制適用で 1 (spec §5.4)。 */
    force: integer("force").notNull().default(0),
    /** 提案を出したチャットメッセージ (カード紐付け)。 */
    messageId: text("message_id"),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
    appliedAt: integer("applied_at"),
  },
  (t) => [
    index("change_sets_work_idx").on(t.workId, t.createdAt),
    // 同一メッセージからの変更セット重複作成を防ぐ (orchestrator 再開の冪等)
    uniqueIndex("change_sets_message_uq").on(t.messageId),
  ],
);

export const reviewFindings = sqliteTable(
  "review_findings",
  {
    id: text("id").primaryKey(),
    changeSetId: text("change_set_id").notNull(),
    /** conflict | info */
    kind: text("kind").notNull(),
    /** high | medium | low */
    severity: text("severity").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail").notNull().default(""),
    sceneId: text("scene_id"),
    factId: text("fact_id"),
    /** open | dismissed */
    status: text("status").notNull().default("open"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("review_findings_change_set_idx").on(t.changeSetId),
    index("review_findings_scene_idx").on(t.sceneId),
  ],
);

// ---------------------------------------------------------------------------
// better-auth の管理テーブル (Phase 1a, OAuth ログイン用)。
// 列名・型は better-auth drizzle adapter の想定スキーマに合わせる。
// ---------------------------------------------------------------------------

export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
});

export const accounts = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp_ms",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp_ms",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

/** better-auth drizzle adapter に渡すスキーマ。 */
export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
};
