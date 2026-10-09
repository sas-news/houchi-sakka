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
