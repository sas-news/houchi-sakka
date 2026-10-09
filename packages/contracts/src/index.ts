import { z } from "zod";

/**
 * 放置作家 contracts — API・ジョブ・プロバイダーの型と Zod スキーマの正本。
 * spec: docs/spec.md §7.5 (ジョブ実行モデル), §8, §9
 */

// ---------------------------------------------------------------------------
// AgentJob
// ---------------------------------------------------------------------------

export const JOB_KIND_SMOKE_GENERATE = "smoke_generate" as const;

/** ジョブ種別。Phase 0 は smoke_generate のみ。拡張前提の文字列型。 */
export const JobKindSchema = z.string().min(1);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "leased",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const AgentJobSchema = z.object({
  id: z.string(),
  kind: JobKindSchema,
  /** 同一作品のジョブ直列化キー (spec §7.5)。Phase 0 では任意。 */
  work_ref: z.string().nullable(),
  payload: z.record(z.unknown()),
  idempotency_key: z.string(),
  status: JobStatusSchema,
  leased_by: z.string().nullable(),
  /** DB には保持するが、API 応答では lease レスポンス以外に出さない。 */
  lease_token: z.string().nullable(),
  /** epoch ミリ秒。 */
  lease_expires_at: z.number().nullable(),
  attempts: z.number().int(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentJob = z.infer<typeof AgentJobSchema>;

// ---------------------------------------------------------------------------
// ProgressEvent
// ---------------------------------------------------------------------------

export const ProgressEventTypeSchema = z.enum(["status", "token", "note"]);
export type ProgressEventType = z.infer<typeof ProgressEventTypeSchema>;

export const ProgressEventSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  seq: z.number().int(),
  type: ProgressEventTypeSchema,
  data: z.unknown(),
  created_at: z.number(),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

// ---------------------------------------------------------------------------
// ProviderKey (BYO API キー, spec §9)
// ---------------------------------------------------------------------------

export const ProviderKeySchema = z.object({
  id: z.string(),
  /** 将来のユーザーID。Phase 0 では任意文字列。 */
  owner_ref: z.string(),
  label: z.string(),
  /** base64(iv).base64(ciphertext+tag) — 平文は保存しない。 */
  ciphertext: z.string(),
  created_at: z.number(),
});
export type ProviderKey = z.infer<typeof ProviderKeySchema>;

/** API 応答用: ciphertext を含まない公開形。 */
export const ProviderKeyPublicSchema = ProviderKeySchema.omit({
  ciphertext: true,
});
export type ProviderKeyPublic = z.infer<typeof ProviderKeyPublicSchema>;

// ---------------------------------------------------------------------------
// API: POST /api/jobs
// ---------------------------------------------------------------------------

export const CreateJobRequestSchema = z.object({
  kind: JobKindSchema,
  work_ref: z.string().nullish(),
  payload: z.record(z.unknown()),
  idempotency_key: z.string().min(1),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const CreateJobResponseSchema = z.object({
  job: AgentJobSchema,
  /** true = 新規作成, false = idempotency_key 重複で既存を返した。 */
  created: z.boolean(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

// ---------------------------------------------------------------------------
// API: POST /api/jobs/lease
// ---------------------------------------------------------------------------

export const LeaseRequestSchema = z.object({
  executor_id: z.string().min(1),
  lease_ttl_ms: z.number().int().positive().optional(),
});
export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;

export const LeaseResponseSchema = z.object({
  job: AgentJobSchema.nullable(),
  lease_token: z.string().optional(),
  lease_expires_at: z.number().optional(),
});
export type LeaseResponse = z.infer<typeof LeaseResponseSchema>;

// ---------------------------------------------------------------------------
// API: POST /api/jobs/:id/progress|heartbeat|complete|fail, GET /api/jobs/:id
// ---------------------------------------------------------------------------

export const ProgressRequestSchema = z.object({
  lease_token: z.string().min(1),
  type: ProgressEventTypeSchema,
  data: z.unknown(),
});
export type ProgressRequest = z.infer<typeof ProgressRequestSchema>;

export const ProgressResponseSchema = z.object({
  event: ProgressEventSchema,
});
export type ProgressResponse = z.infer<typeof ProgressResponseSchema>;

export const HeartbeatRequestSchema = z.object({
  lease_token: z.string().min(1),
  /** このリース期限を延ばすミリ秒 (省略時はサーバー既定)。 */
  lease_ttl_ms: z.number().int().positive().optional(),
  /** リース延長と同時にジョブの payload.checkpoint へマージする途中状態。 */
  checkpoint: z.record(z.unknown()).optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const CompleteRequestSchema = z.object({
  lease_token: z.string().min(1),
  result: z.unknown(),
});
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;

export const FailRequestSchema = z.object({
  lease_token: z.string().min(1),
  error: z.string(),
});
export type FailRequest = z.infer<typeof FailRequestSchema>;

export const JobResponseSchema = z.object({
  job: AgentJobSchema,
});
export type JobResponse = z.infer<typeof JobResponseSchema>;

// ---------------------------------------------------------------------------
// API: /api/internal/keys (実行体専用)
// ---------------------------------------------------------------------------

export const CreateKeyRequestSchema = z.object({
  owner_ref: z.string().min(1),
  label: z.string().min(1),
  api_key: z.string().min(1),
});
export type CreateKeyRequest = z.infer<typeof CreateKeyRequestSchema>;

export const CreateKeyResponseSchema = z.object({
  key: ProviderKeyPublicSchema,
});
export type CreateKeyResponse = z.infer<typeof CreateKeyResponseSchema>;

export const GetKeyResponseSchema = z.object({
  api_key: z.string(),
});
export type GetKeyResponse = z.infer<typeof GetKeyResponseSchema>;

// ---------------------------------------------------------------------------
// API エラー
// ---------------------------------------------------------------------------

export const ApiErrorCodeSchema = z.enum([
  "unauthorized",
  "bad_request",
  "not_found",
  "lease_conflict",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Provider (spec §8.1: プロバイダー非依存インターフェース)
// ---------------------------------------------------------------------------

export const ProviderRoleSchema = z.enum([
  "system",
  "developer",
  "user",
  "assistant",
]);
export type ProviderRole = z.infer<typeof ProviderRoleSchema>;

export const ProviderInputMessageSchema = z.object({
  role: ProviderRoleSchema,
  content: z.string(),
});
export type ProviderInputMessage = z.infer<typeof ProviderInputMessageSchema>;

export const ProviderRequestSchema = z.object({
  model: z.string().min(1),
  input: z.array(ProviderInputMessageSchema).min(1),
  stream: z.boolean().optional(),
});
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;

export const ProviderUsageSchema = z.union([
  z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
  /** 利用量が取得できない場合は偽装せず 'unknown' (spec §7.4)。 */
  z.literal("unknown"),
]);
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const ProviderResponseSchema = z.object({
  output_text: z.string(),
  usage: ProviderUsageSchema,
});
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;

// ---------------------------------------------------------------------------
// smoke_generate ジョブ payload (Phase 0)
// ---------------------------------------------------------------------------

export const SmokeCheckpointSchema = z
  .object({
    /** persist_result 済みのプロバイダー応答。再開時のスキップ判定に使う。 */
    provider_result: ProviderResponseSchema.optional(),
  })
  .passthrough();
export type SmokeCheckpoint = z.infer<typeof SmokeCheckpointSchema>;

export const SmokeGeneratePayloadSchema = z.object({
  model: z.string().min(1),
  input: z.array(ProviderInputMessageSchema).min(1),
  /** 'openai' (既定) | 'stub' など runner のプロバイダーレジストリ名。 */
  provider: z.string().optional(),
  /** provider_keys.id。runner の --env-key / stub では省略可。 */
  key_ref: z.string().optional(),
  stream: z.boolean().optional(),
  /** 実行途中の永続チェックポイント (サーバーが payload 内で保持)。 */
  checkpoint: SmokeCheckpointSchema.optional(),
});
export type SmokeGeneratePayload = z.infer<typeof SmokeGeneratePayloadSchema>;

export const SmokeGenerateResultSchema = z.object({
  kind: z.literal(JOB_KIND_SMOKE_GENERATE),
  model: z.string(),
  output_text: z.string(),
  usage: ProviderUsageSchema,
  /** チェックポイントから再開してプロバイダー呼び出しをスキップしたか。 */
  resumed_from_checkpoint: z.boolean(),
});
export type SmokeGenerateResult = z.infer<typeof SmokeGenerateResultSchema>;
