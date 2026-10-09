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
  ciphertext: text("ciphertext").notNull(),
  createdAt: integer("created_at").notNull(),
});
