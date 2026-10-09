import { z } from "zod";

/**
 * 放置作家 contracts — API・ジョブ・プロバイダーの型と Zod スキーマの正本。
 * spec: docs/spec.md §7.5 (ジョブ実行モデル), §8, §9
 */

// ---------------------------------------------------------------------------
// AgentJob
// ---------------------------------------------------------------------------

export const JOB_KIND_SMOKE_GENERATE = "smoke_generate" as const;
export const JOB_KIND_ORCHESTRATOR_TURN = "orchestrator_turn" as const;

/** ジョブ種別。拡張前提の文字列型。 */
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
  /** 同一作品のジョブ直列化キー (spec §7.5)。works.id を入れる。 */
  work_ref: z.string().nullable(),
  /** ジョブを起こしたユーザー (users.id)。実行体経由ジョブは null 可。 */
  user_ref: z.string().nullable(),
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

/** BYO キーのプロバイダー名 (runner のプロバイダーレジストリ名と一致)。 */
export const KeyProviderSchema = z.enum(["openai", "anthropic"]);
export type KeyProvider = z.infer<typeof KeyProviderSchema>;

export const ProviderKeySchema = z.object({
  id: z.string(),
  /** 所有者のユーザーID (users.id)。 */
  owner_ref: z.string(),
  label: z.string(),
  /** どのプロバイダーのキーか (openai | anthropic)。 */
  provider: z.string(),
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
  /** ジョブを起こしたユーザー (キー解決の owner 照合に使う)。 */
  user_ref: z.string().nullish(),
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
  provider: z.string().min(1).optional(),
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

/**
 * POST /api/internal/keys/:ref/resolve — 実行体のキー解決 (Phase 1a)。
 * ジョブを起こしたユーザー (job.user_ref) とキーの owner_ref が一致する
 * 場合だけ平文を返す (spec §9: 利用者の認可境界)。
 */
export const ResolveKeyRequestSchema = z.object({
  job_id: z.string().min(1),
});
export type ResolveKeyRequest = z.infer<typeof ResolveKeyRequestSchema>;

export const ResolveKeyResponseSchema = z.object({
  api_key: z.string(),
});
export type ResolveKeyResponse = z.infer<typeof ResolveKeyResponseSchema>;

// ---------------------------------------------------------------------------
// API エラー
// ---------------------------------------------------------------------------

export const ApiErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
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

// ---------------------------------------------------------------------------
// User (better-auth が管理する users テーブルと対応)
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

// ---------------------------------------------------------------------------
// Work / ChatThread / ChatMessage (Phase 1a, spec §3, §6.1)
// ---------------------------------------------------------------------------

/**
 * 作品の進行状態 (Phase 1a の最小遷移)。
 * setup: 対話で初期化中 (作品を作った直後)
 * active: 対話が始まり、初期化が進行中
 */
export const WorkStatusSchema = z.enum(["setup", "active"]);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

export const WorkSchema = z.object({
  id: z.string(),
  owner_ref: z.string(),
  title: z.string(),
  premise: z.string(),
  genre: z.string(),
  status: WorkStatusSchema,
  created_at: z.number(),
  updated_at: z.number(),
});
export type Work = z.infer<typeof WorkSchema>;

export const ChatThreadSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  created_at: z.number(),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  role: ChatRoleSchema,
  content: z.string(),
  /** assistant メッセージを生成したジョブ (二重確定防止のユニークキー)。 */
  job_id: z.string().nullable(),
  created_at: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ---------------------------------------------------------------------------
// orchestrator_turn ジョブ (Phase 1a, spec §7.5: 対話1往復=1ジョブ)
// ---------------------------------------------------------------------------

export const OrchestratorCheckpointSchema = z
  .object({
    /** persist 済みのプロバイダー応答。再開時にプロバイダー呼び出しをスキップ。 */
    provider_result: ProviderResponseSchema.optional(),
    /** 永続化済みの assistant メッセージ ID。再開時にメッセージ重複を防ぐ。 */
    assistant_message_id: z.string().optional(),
  })
  .passthrough();
export type OrchestratorCheckpoint = z.infer<typeof OrchestratorCheckpointSchema>;

export const OrchestratorTurnPayloadSchema = z.object({
  thread_id: z.string().min(1),
  work_id: z.string().min(1),
  /** ジョブを起こしたユーザー。キー解決の owner 照合に使う。 */
  user_ref: z.string().min(1),
  /** provider_keys.id。 */
  key_ref: z.string().min(1),
  /** runner のプロバイダーレジストリ名 (キーの provider と一致)。 */
  provider: z.string().min(1),
  model: z.string().min(1),
  /** この往復の起点になったユーザーメッセージ。 */
  trigger_message_id: z.string().min(1),
  checkpoint: OrchestratorCheckpointSchema.optional(),
});
export type OrchestratorTurnPayload = z.infer<typeof OrchestratorTurnPayloadSchema>;

export const OrchestratorTurnResultSchema = z.object({
  kind: z.literal(JOB_KIND_ORCHESTRATOR_TURN),
  message_id: z.string(),
  /** 応答の先頭プレビュー (全文は chat_messages に保存済み)。 */
  reply_preview: z.string(),
});
export type OrchestratorTurnResult = z.infer<typeof OrchestratorTurnResultSchema>;

// ---------------------------------------------------------------------------
// API: ユーザー向け (セッション認証)
// ---------------------------------------------------------------------------

/** GET /api/config — ログイン不要の公開設定。 */
export const ConfigResponseSchema = z.object({
  dev_login_enabled: z.boolean(),
});
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;

/** GET /api/me — ログイン中ユーザー。未ログインは 401。 */
export const MeResponseSchema = z.object({
  user: UserSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** POST /api/works — 作品作成 (対話スレッドも同時に作る)。 */
export const CreateWorkRequestSchema = z.object({
  title: z.string().min(1).max(200),
  premise: z.string().max(2000).optional(),
});
export type CreateWorkRequest = z.infer<typeof CreateWorkRequestSchema>;

export const WorkResponseSchema = z.object({
  work: WorkSchema,
});
export type WorkResponse = z.infer<typeof WorkResponseSchema>;

export const WorkListResponseSchema = z.object({
  works: z.array(WorkSchema),
});
export type WorkListResponse = z.infer<typeof WorkListResponseSchema>;

/** GET /api/works/:id — 作品+スレッド+メッセージ+進行中ジョブ (ポーリング先)。 */
export const WorkDetailResponseSchema = z.object({
  work: WorkSchema,
  thread: ChatThreadSchema,
  messages: z.array(ChatMessageSchema),
  /** queued/leased の orchestrator ジョブと進捗末尾。実行中でなければ null。 */
  active_job: z
    .object({
      job: AgentJobSchema,
      progress: z.array(ProgressEventSchema),
    })
    .nullable(),
  /** 直前に送られてキュー待ちのジョブ数 (active_job を除く)。 */
  queued_jobs: z.number().int(),
});
export type WorkDetailResponse = z.infer<typeof WorkDetailResponseSchema>;

/** POST /api/works/:id/messages — 送信→orchestrator_turn をキュー。 */
export const CreateMessageRequestSchema = z.object({
  content: z.string().min(1).max(20000),
  /** 使うキー (省略時はユーザーの最新キー)。 */
  key_id: z.string().optional(),
  /** モデル名 (省略時はサーバー既定)。 */
  model: z.string().optional(),
});
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;

export const CreateMessageResponseSchema = z.object({
  message: ChatMessageSchema,
  job: AgentJobSchema,
});
export type CreateMessageResponse = z.infer<typeof CreateMessageResponseSchema>;

/** POST /api/keys — BYO キー登録 (セッションユーザー所有)。 */
export const CreateUserKeyRequestSchema = z.object({
  label: z.string().min(1).max(100),
  provider: KeyProviderSchema,
  api_key: z.string().min(1).max(500),
});
export type CreateUserKeyRequest = z.infer<typeof CreateUserKeyRequestSchema>;

export const KeyListResponseSchema = z.object({
  keys: z.array(ProviderKeyPublicSchema),
});
export type KeyListResponse = z.infer<typeof KeyListResponseSchema>;

/** POST /api/dev/login — DEV_LOGIN_ENABLED=true の時だけ有効。 */
export const DevLoginResponseSchema = z.object({
  ok: z.literal(true),
});
export type DevLoginResponse = z.infer<typeof DevLoginResponseSchema>;

// ---------------------------------------------------------------------------
// API: /api/internal/* (実行体専用, EXECUTOR_TOKEN)
// ---------------------------------------------------------------------------

/** GET /api/internal/threads/:id/context — orchestrator の入力材料。 */
export const ThreadContextResponseSchema = z.object({
  work: WorkSchema,
  thread: ChatThreadSchema,
  messages: z.array(ChatMessageSchema),
});
export type ThreadContextResponse = z.infer<typeof ThreadContextResponseSchema>;

/** POST /api/internal/threads/:id/messages — assistant メッセージ永続化 (job_id で冪等)。 */
export const AppendMessageRequestSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  job_id: z.string().min(1),
});
export type AppendMessageRequest = z.infer<typeof AppendMessageRequestSchema>;

export const AppendMessageResponseSchema = z.object({
  message: ChatMessageSchema,
});
export type AppendMessageResponse = z.infer<typeof AppendMessageResponseSchema>;

/**
 * POST /api/internal/works/:id/patch — WORK_PATCH の適用。
 * orchestrator が返答末尾に出す構造化パッチをサーバー側で検証して適用する。
 */
export const WorkPatchRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  premise: z.string().max(20000).optional(),
  genre: z.string().max(200).optional(),
  status: WorkStatusSchema.optional(),
});
export type WorkPatchRequest = z.infer<typeof WorkPatchRequestSchema>;
