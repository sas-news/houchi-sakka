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
export const JOB_KIND_GENERATE_SCENE = "generate_scene" as const;
export const JOB_KIND_PLAN_WORK = "plan_work" as const;
export const JOB_KIND_REVIEW_CHANGE = "review_change" as const;

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
export const KeyProviderSchema = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "groq",
]);
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

// ---------------------------------------------------------------------------
// AgentStep — ジョブ内の実行ステップ記録 (spec §7.4)。
// 進捗イベントが UI 表示用なのに対し、こちらは監査・再開のための永続記録:
// ステップ名・開始/終了・モデル/プロバイダー・使用量・成果物・エラー。
// ---------------------------------------------------------------------------

export const AgentStepSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  seq: z.number().int(),
  /** ステップ名 (call_provider / persist_message など)。 */
  name: z.string(),
  status: z.enum(["ok", "error"]),
  started_at: z.number(),
  ended_at: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  /** 計測された使用量 ('unknown' = 取得不可, spec §7.4)。 */
  usage: z.unknown().nullable(),
  /** 成果物の参照 ({kind, id} など)。 */
  artifact: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

/** POST /api/jobs/:id/steps — 実行体がステップ記録を1件書く。 */
export const RecordStepRequestSchema = z.object({
  lease_token: z.string().min(1),
  name: z.string().min(1).max(200),
  status: z.enum(["ok", "error"]).default("ok"),
  started_at: z.number(),
  /** 省略時はサーバー受信時刻。 */
  ended_at: z.number().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  usage: z.unknown().optional(),
  artifact: z.record(z.unknown()).optional(),
  error: z.string().max(4000).optional(),
});
export type RecordStepRequest = z.infer<typeof RecordStepRequestSchema>;

export const RecordStepResponseSchema = z.object({
  step: AgentStepSchema,
});
export type RecordStepResponse = z.infer<typeof RecordStepResponseSchema>;

/** GET /api/works/:id/jobs/:jobId — ユーザー向けジョブ詳細 (ステップ一覧付き)。 */
export const JobDetailResponseSchema = z.object({
  job: AgentJobSchema,
  steps: z.array(AgentStepSchema),
});
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>;

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
  "conflict",
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

/**
 * 自律運転レベル (spec §7.2)。off=対話のみ / draft=草案・提案まで自動
 * (正典確定・公開はしない)。review_commit/auto_release は未実装。
 */
export const AutonomyLevelSchema = z.enum(["off", "draft"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const WorkSchema = z.object({
  id: z.string(),
  owner_ref: z.string(),
  title: z.string(),
  premise: z.string(),
  genre: z.string(),
  status: WorkStatusSchema,
  /** StoryCharter (作品の狙い・制約) JSON。未作成は null (spec §6.1)。 */
  charter: z.unknown().nullable(),
  /** NarrativePolicy (執筆方式・計画先行範囲) JSON。未作成は null。 */
  policy: z.unknown().nullable(),
  /** この作品で使うプロバイダー/モデル/キー (未設定は null → 既定解決)。 */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  key_ref: z.string().nullable(),
  /** 自律運転レベル (spec §7.2)。 */
  autonomy_level: AutonomyLevelSchema,
  /** 自律継続の残り往復数 (spec §7.3 利用者設定の実行上限)。 */
  autonomy_budget: z.number().int(),
  /** 現在の正典リビジョン (spec §6.3。変更セット適用ごとに +1)。 */
  canon_rev: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Work = z.infer<typeof WorkSchema>;

// ---------------------------------------------------------------------------
// POST /api/works/:id/autonomy — 自律運転の開始/停止 (spec §7.2/§7.3)。
// 開始時に実行上限を明示する (spec: 運転開始前に実行上限を明示)。
// ---------------------------------------------------------------------------

export const UpdateAutonomyRequestSchema = z.object({
  action: z.enum(["start", "stop"]),
  /** 開始時の自動往復上限 (既定 10)。 */
  max_turns: z.number().int().min(1).max(100).optional(),
});
export type UpdateAutonomyRequest = z.infer<typeof UpdateAutonomyRequestSchema>;

export const UpdateAutonomyResponseSchema = z.object({
  work: WorkSchema,
});

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
  /** この往復の起点になったユーザーメッセージ (自律往復では省略)。 */
  trigger_message_id: z.string().optional(),
  /** 自律運転による往復 (spec §7.2。指示文を入力に追加する)。 */
  autonomous: z.boolean().optional(),
  checkpoint: OrchestratorCheckpointSchema.optional(),
});
export type OrchestratorTurnPayload = z.infer<typeof OrchestratorTurnPayloadSchema>;

export const OrchestratorTurnResultSchema = z.object({
  kind: z.literal(JOB_KIND_ORCHESTRATOR_TURN),
  message_id: z.string(),
  /** 応答の先頭プレビュー (全文は chat_messages に保存済み)。 */
  reply_preview: z.string(),
  /** この往復で適用した副作用 (work_patch/propose 等のマーカー名)。 */
  actions: z.array(z.string()).optional(),
  /** <<AUTO_STOP>> で自律運転の終了を要求 (spec §7.3)。 */
  auto_stop: z.boolean().optional(),
});
export type OrchestratorTurnResult = z.infer<typeof OrchestratorTurnResultSchema>;

// ---------------------------------------------------------------------------
// generate_scene ジョブ (Phase 1b, spec §4.4/§7.5)
// ---------------------------------------------------------------------------

export const GenerateSceneCheckpointSchema = z
  .object({
    /** write 段のスキル出力 (WriterOutput, Phase 2a 多段パイプライン)。 */
    draft: z.unknown().optional(),
    /** critique 段のスキル出力 (CriticOutput)。 */
    critique: z.unknown().optional(),
    /** revise 段のスキル出力 (改稿後 WriterOutput)。 */
    final: z.unknown().optional(),
    /** 永続化済みの scene_revisions.id。 */
    revision_id: z.string().optional(),
    rev_no: z.number().int().optional(),
    /** canon_facts_new の記録済みフラグ。 */
    canon_recorded: z.boolean().optional(),
    /** dependency_edges の記録済みフラグ。 */
    deps_recorded: z.boolean().optional(),
  })
  .passthrough();
export type GenerateSceneCheckpoint = z.infer<
  typeof GenerateSceneCheckpointSchema
>;

export const GenerateScenePayloadSchema = z.object({
  scene_id: z.string().min(1),
  /** ゲート検証に使う writing_contracts.id (approved 必須)。 */
  contract_id: z.string().min(1),
  work_id: z.string().min(1),
  /** ジョブを起こしたユーザー (キー解決の owner 照合に使う)。 */
  user_ref: z.string().min(1),
  key_ref: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** 書き直し指示など (初回生成は省略)。 */
  instruction: z.string().optional(),
  checkpoint: GenerateSceneCheckpointSchema.optional(),
});
export type GenerateScenePayload = z.infer<typeof GenerateScenePayloadSchema>;

export const GenerateSceneResultSchema = z.object({
  kind: z.literal(JOB_KIND_GENERATE_SCENE),
  scene_id: z.string(),
  revision_id: z.string(),
  rev_no: z.number().int(),
  resumed_from_checkpoint: z.boolean(),
  /** high 指摘があって revise 段を回したか。 */
  revised: z.boolean(),
  /** critic の検査結果サマリ。 */
  critique_summary: z.object({
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    notes: z.number().int(),
  }),
});
export type GenerateSceneResult = z.infer<typeof GenerateSceneResultSchema>;

// ---------------------------------------------------------------------------
// plan_work ジョブ (Phase 2a, spec §7.1 プランナー)
// ---------------------------------------------------------------------------

export const PlanWorkCheckpointSchema = z
  .object({
    /** planner スキルの検証済み出力 (PlanProposalPayload)。 */
    plan: z.unknown().optional(),
    /** 永続化済みの assistant メッセージ ID。 */
    assistant_message_id: z.string().optional(),
    /** 作成済みの plan 提案 ID。 */
    proposal_id: z.string().optional(),
  })
  .passthrough();
export type PlanWorkCheckpoint = z.infer<typeof PlanWorkCheckpointSchema>;

export const PlanWorkPayloadSchema = z.object({
  work_id: z.string().min(1),
  /** 計画提案カードを出すスレッド (assistant メッセージの追加先)。 */
  thread_id: z.string().min(1),
  user_ref: z.string().min(1),
  key_ref: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** 対話からの計画指示 (焦点・範囲など)。 */
  guidance: z.string().optional(),
  checkpoint: PlanWorkCheckpointSchema.optional(),
});
export type PlanWorkPayload = z.infer<typeof PlanWorkPayloadSchema>;

export const PlanWorkResultSchema = z.object({
  kind: z.literal(JOB_KIND_PLAN_WORK),
  proposal_id: z.string(),
  episode_count: z.number().int(),
  scene_count: z.number().int(),
});
export type PlanWorkResult = z.infer<typeof PlanWorkResultSchema>;

// ---------------------------------------------------------------------------
// API: ユーザー向け (セッション認証)
// ---------------------------------------------------------------------------
// Phase 1b: 話・シーン・Writing Contract・正典メモ・提案 (spec §3, §4.4, §6)
// ---------------------------------------------------------------------------

/** 話 (エピソード)。シーンを順序付きで束ねる単位 (spec §6.4)。 */
export const EpisodeSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  ord: z.number().int(),
  title: z.string(),
  status: z.string(),
  created_at: z.number(),
});
export type Episode = z.infer<typeof EpisodeSchema>;

/** シーンの状態。approved → generate_scene が走れる (spec §4.4 ゲート)。 */
export const SceneStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "generated",
]);
export type SceneStatus = z.infer<typeof SceneStatusSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  episode_id: z.string(),
  ord: z.number().int(),
  title: z.string(),
  purpose: z.string(),
  status: SceneStatusSchema,
  created_at: z.number(),
  updated_at: z.number(),
});
export type Scene = z.infer<typeof SceneSchema>;

/** リビジョンの出所。manual_edit = 本文ビューでの手編集 (spec §5.5)。 */
export const RevisionSourceSchema = z.enum(["ai", "manual_edit"]);
export type RevisionSource = z.infer<typeof RevisionSourceSchema>;

export const SceneRevisionSchema = z.object({
  id: z.string(),
  scene_id: z.string(),
  rev_no: z.number().int(),
  /** Tiptap doc JSON (本文の正本, spec §8.1)。 */
  content_json: z.unknown(),
  source: RevisionSourceSchema,
  /** AI生成リビジョンを作ったジョブ (手編集は null)。 */
  job_id: z.string().nullable(),
  /** このリビジョンを記録した変更セット (手編集の紐付け, spec §5.5)。 */
  change_set_id: z.string().nullable(),
  created_at: z.number(),
});
export type SceneRevision = z.infer<typeof SceneRevisionSchema>;

/**
 * Writing Contract の中身 (spec §3/§4.4 を Phase 1b 用に簡潔化)。
 * 本文生成前に承認が必須のゲート条件。
 */
export const WritingContractPayloadSchema = z.object({
  /** この話・シーンが物語に果たす役割。 */
  role: z.string().default(""),
  /** 視点人物・視点の方針。 */
  pov: z.string().default(""),
  /** 起こすべき出来事。 */
  required_events: z.array(z.string()).default([]),
  /** 避けるべき出来事・開示制約。 */
  forbidden: z.array(z.string()).default([]),
  /** 視点人物が知っている/知らないこと。 */
  knowledge_notes: z.string().default(""),
  /** 前後のシーン・アークへの因果的接続。 */
  connections: z.string().default(""),
});
export type WritingContractPayload = z.infer<
  typeof WritingContractPayloadSchema
>;

export const WritingContractStatusSchema = z.enum([
  "draft",
  "approved",
  "rejected",
]);
export type WritingContractStatus = z.infer<
  typeof WritingContractStatusSchema
>;

export const WritingContractSchema = z.object({
  id: z.string(),
  scene_id: z.string(),
  status: WritingContractStatusSchema,
  payload: WritingContractPayloadSchema,
  created_at: z.number(),
  /** 承認/却下が決まった時刻。未決定は null。 */
  decided_at: z.number().nullable(),
});
export type WritingContract = z.infer<typeof WritingContractSchema>;

/**
 * コミットメント状態 (spec §4.3): 正典メモの確度。
 * - fixed: 確定した正典。変更は影響分析つきの変更セット経由
 * - committed: 近い将来の計画として約束済み
 * - provisional: 候補・仮説。正典の事実として本文に利用してはならない
 * - open_by_design: 意図的に未確定 (執筆をブロックしない)
 * - undecided: まだ判断していない
 */
export const COMMITMENT_LEVELS = [
  "fixed",
  "committed",
  "provisional",
  "open_by_design",
  "undecided",
] as const;
export const CommitmentLevelSchema = z.enum(COMMITMENT_LEVELS);
export type CommitmentLevel = z.infer<typeof CommitmentLevelSchema>;

/**
 * 開示ポリシー (spec §4.3 Secret/Reveal-constrained)。
 * secret = 読者にも未登場人物にも知られたくない事実
 * (reveal 制約の詳細条件は後フェーズ)。
 */
export const DISCLOSURE_POLICIES = ["normal", "secret"] as const;
export const DisclosurePolicySchema = z.enum(DISCLOSURE_POLICIES);
export type DisclosurePolicy = z.infer<typeof DisclosurePolicySchema>;

/** コミットメント状態の日本語ラベル (UI・プロンプト・workspace で共通)。 */
export const COMMITMENT_LABELS: Record<CommitmentLevel, string> = {
  fixed: "確定",
  committed: "約束済み",
  provisional: "仮置き",
  open_by_design: "意図的未確定",
  undecided: "未判断",
};

/** 開示ポリシーの日本語ラベル。 */
export const DISCLOSURE_LABELS: Record<DisclosurePolicy, string> = {
  normal: "通常",
  secret: "秘密",
};

/**
 * プロンプトや /canon/facts.md に付ける先頭ラベル (例: "[秘密・仮置き] ")。
 * fixed + normal はラベルなし (既定の正典は無印)。
 */
export function canonFactLabel(fact: {
  commitment?: string | null | undefined;
  disclosure?: string | null | undefined;
}): string {
  const tags: string[] = [];
  if (fact.disclosure === "secret") tags.push(DISCLOSURE_LABELS.secret);
  if (fact.commitment && fact.commitment !== "fixed") {
    const label =
      COMMITMENT_LABELS[fact.commitment as CommitmentLevel] ??
      fact.commitment;
    tags.push(label);
  }
  return tags.length > 0 ? `[${tags.join("・")}] ` : "";
}

/** 正典メモ (Phase 1b の最小版: 自然言語文 + 出所のみ, spec §6.4)。 */
export const CanonFactSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  statement: z.string(),
  /** コミットメント状態 (spec §4.3。未設定の既存行は fixed 扱い)。 */
  commitment: CommitmentLevelSchema.default("fixed"),
  /** 開示ポリシー (spec §4.3)。 */
  disclosure: DisclosurePolicySchema.default("normal"),
  /** 出所 (例: "orchestrator", "author", "change_set:<id>")。 */
  provenance: z.string(),
  /** この行が現行になった正典リビジョン (spec §6.3。無バージョン追加は null)。 */
  valid_from_rev: z.number().int().nullable(),
  /** 閉じられた正典リビジョン (null=現行)。 */
  valid_to_rev: z.number().int().nullable(),
  /**
   * リビジョン跨ぎの安定ID (spec §6.4)。改定で新行になっても引き継がれる。
   * 0009 適用前の行やリファレンス未整備の経路では null になりうるので
   * 省略時は id と同じ扱いにする。
   */
  fact_ref: z.string().nullish(),
  created_at: z.number(),
});
export type CanonFact = z.infer<typeof CanonFactSchema>;

// ---------------------------------------------------------------------------
// StoryEntity / EntityAlias / KnowledgeEvent (spec §6.4, 知識追跡 MVP)
// ---------------------------------------------------------------------------

/** 登場要素の種別 (spec §6.4)。 */
export const ENTITY_KINDS = [
  "character",
  "place",
  "org",
  "item",
  "concept",
] as const;
export const EntityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKindSchema>;

/** 種別の日本語ラベル (UI・プロンプト・workspace で共通)。 */
export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  character: "人物",
  place: "場所",
  org: "組織",
  item: "物品",
  concept: "概念",
};

/**
 * 登場要素 (spec §6.4 StoryEntity)。時系列モデル:
 * id はリビジョン行のPK、entity_id はリビジョンを跨ぐ安定ID
 * (aliases/fact_entities/knowledge_events は entity_id を指す)。
 */
export const StoryEntitySchema = z.object({
  id: z.string(),
  entity_id: z.string(),
  work_id: z.string(),
  kind: EntityKindSchema,
  name: z.string(),
  summary: z.string().default(""),
  valid_from_rev: z.number().int().nullable(),
  valid_to_rev: z.number().int().nullable(),
  created_at: z.number(),
});
export type StoryEntity = z.infer<typeof StoryEntitySchema>;

/** 別名・表記揺れ・愛称 (entity_id 安定ID参照)。 */
export const EntityAliasSchema = z.object({
  id: z.string(),
  entity_id: z.string(),
  alias: z.string(),
  created_at: z.number(),
});
export type EntityAlias = z.infer<typeof EntityAliasSchema>;

/** 言及検出・コンテキスト渡し用のエンティティ+別名セット。 */
export const EntityWithAliasesSchema = StoryEntitySchema.extend({
  aliases: z.array(z.string()).default([]),
});
export type EntityWithAliases = z.infer<typeof EntityWithAliasesSchema>;

/**
 * 誰が何を・どこから知ったか (spec §6.4 KnowledgeEvent)。
 * entity_id=知った人物 (安定ID)、fact_id=canon_facts.fact_ref (安定ID)。
 */
export const KnowledgeEventSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  entity_id: z.string(),
  /** fact_ref (安定ID)。改定後も同じ事実を指す。 */
  fact_id: z.string(),
  scene_id: z.string().nullable(),
  /** 情報源 (目撃/伝聞/推論/記述 など)。 */
  source: z.string(),
  valid_from_rev: z.number().int().nullable(),
  valid_to_rev: z.number().int().nullable(),
  created_at: z.number(),
});
export type KnowledgeEvent = z.infer<typeof KnowledgeEventSchema>;

/** GET /api/works/:id/entities — 資料タブ「登場要素」一覧+詳細 (読み取り専用)。 */
export const WorkEntityDetailSchema = z.object({
  id: z.string(),
  entity_id: z.string(),
  kind: EntityKindSchema,
  name: z.string(),
  summary: z.string(),
  aliases: z.array(z.string()),
  /** 紐付く現行の正典メモ (fact_entities 経由)。 */
  facts: z.array(CanonFactSchema),
  /** この人物が知った知識イベント (現行のみ。fact文面とシーン名つき)。 */
  knowledge_events: z.array(
    KnowledgeEventSchema.extend({
      fact_statement: z.string(),
      scene_title: z.string().nullable(),
    }),
  ),
});
export type WorkEntityDetail = z.infer<typeof WorkEntityDetailSchema>;

export const WorkEntitiesResponseSchema = z.object({
  entities: z.array(WorkEntityDetailSchema),
});
export type WorkEntitiesResponse = z.infer<typeof WorkEntitiesResponseSchema>;

/** チャット内承認カードの種別。 */
export const PROPOSAL_KIND_WRITING_CONTRACT = "writing_contract" as const;
/** plan_work が作る計画提案 (episodes/scenes の一括作成案)。 */
export const PROPOSAL_KIND_PLAN = "plan" as const;
/** workspace 経由の書き込み提案 (監査。直接確定しない)。 */
export const PROPOSAL_KIND_WORKSPACE_WRITE = "workspace_write" as const;
export const ProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  thread_id: z.string(),
  /** 提案を表示する assistant メッセージ。 */
  message_id: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  status: ProposalStatusSchema,
  decided_at: z.number().nullable(),
  created_at: z.number(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** <<PROPOSE …>> マーカーが運ぶ提案内容 (episode+scene+contract セット)。 */
export const ProposeScenePayloadSchema = z.object({
  /** 話のタイトル。省略時は最新 episode、無ければ「第1話」を自動作成。 */
  episode_title: z.string().optional(),
  scene_title: z.string().min(1),
  scene_purpose: z.string().default(""),
  contract: WritingContractPayloadSchema,
});
export type ProposeScenePayload = z.infer<typeof ProposeScenePayloadSchema>;

/** kind="plan" 提案の payload (planner スキルの出力)。 */
export const PlanSceneInputSchema = z.object({
  title: z.string().min(1),
  purpose: z.string().default(""),
});
export const PlanEpisodeInputSchema = z.object({
  title: z.string().min(1),
  scenes: z.array(PlanSceneInputSchema),
});
export const PlanProposalPayloadSchema = z.object({
  episodes: z.array(PlanEpisodeInputSchema),
});
export type PlanProposalPayload = z.infer<typeof PlanProposalPayloadSchema>;

// ---------------------------------------------------------------------------
// DependencyEdge (Phase 2a, spec §6.1/§6.4: 依存宣言の主経路)
// ---------------------------------------------------------------------------

export const DependencyEdgeSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  scene_id: z.string(),
  /** 依存先の種別 (canon_fact | plan | scene | contract …)。 */
  target_kind: z.string(),
  /** 依存先の参照 (事実文・計画タイトル等、宣言側の言い方のまま)。 */
  target_ref: z.string(),
  created_at: z.number(),
});
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

export const DependencyEdgeInputSchema = z.object({
  target_kind: z.string().min(1),
  target_ref: z.string().min(1),
});
export type DependencyEdgeInput = z.infer<typeof DependencyEdgeInputSchema>;

/** POST /api/internal/scenes/:id/dependencies — writer の依存宣言の記録。 */
export const RecordDependenciesRequestSchema = z.object({
  edges: z.array(DependencyEdgeInputSchema).max(100),
});
export type RecordDependenciesRequest = z.infer<
  typeof RecordDependenciesRequestSchema
>;

export const DependencyEdgesResponseSchema = z.object({
  edges: z.array(DependencyEdgeSchema),
  /** 実際に追加された件数 (重複スキップ後)。 */
  added: z.number().int(),
});
export type DependencyEdgesResponse = z.infer<
  typeof DependencyEdgesResponseSchema
>;

// ---------------------------------------------------------------------------
// Workspace 仮想FS (Phase 2a, spec §7.1 コンテキスト担当の窓口)
// ---------------------------------------------------------------------------

/** 作品データを仮想ファイルとして公開する一覧エントリ。 */
export const WorkspaceFileSchema = z.object({
  path: z.string(),
  /** 内容を載せない要約 (サイズ・件数・タイトル程度)。 */
  summary: z.string(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

export const WorkspaceFilesResponseSchema = z.object({
  files: z.array(WorkspaceFileSchema),
});
export type WorkspaceFilesResponse = z.infer<
  typeof WorkspaceFilesResponseSchema
>;

export const WorkspaceFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type WorkspaceFileContent = z.infer<typeof WorkspaceFileContentSchema>;

/** POST /api/internal/works/:id/workspace/write — エージェントの書き込み提案。 */
export const WorkspaceWriteRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** 提案者 (job 名・スキル名などの出所記録)。 */
  provenance: z.string().min(1),
});
export type WorkspaceWriteRequest = z.infer<typeof WorkspaceWriteRequestSchema>;

export const WorkspaceWriteResponseSchema = z.object({
  proposal: ProposalSchema,
  /** apply 対応パスか (false=記録のみ)。 */
  supported: z.boolean(),
});
export type WorkspaceWriteResponse = z.infer<
  typeof WorkspaceWriteResponseSchema
>;

/** kind="plan" の承認応答。 */
export const ApprovePlanProposalResponseSchema = z.object({
  proposal: ProposalSchema,
  episodes: z.array(EpisodeSchema),
  scenes: z.array(SceneSchema),
});
export type ApprovePlanProposalResponse = z.infer<
  typeof ApprovePlanProposalResponseSchema
>;

/** kind="workspace_write" の承認応答 (正典メモへの追記件数)。 */
export const ApproveWorkspaceWriteResponseSchema = z.object({
  proposal: ProposalSchema,
  added: z.number().int(),
});
export type ApproveWorkspaceWriteResponse = z.infer<
  typeof ApproveWorkspaceWriteResponseSchema
>;

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
  /** チャット内承認カードの台帳 (新しい順)。 */
  proposals: z.array(z.lazy(() => ProposalSchema)),
  /** queued/leased の orchestrator ジョブと進捗末尾。実行中でなければ null。 */
  active_job: z
    .object({
      job: AgentJobSchema,
      progress: z.array(ProgressEventSchema),
    })
    .nullable(),
  /** 直前に送られてキュー待ちのジョブ数 (active_job を除く)。 */
  queued_jobs: z.number().int(),
  /** 変更タブ用の変更セット一覧 (findings 付き、古い順)。 */
  change_sets: z.array(z.lazy(() => ChangeSetWithFindingsSchema)),
  /**
   * 直近ジョブの実行履歴 (全 status、created_at 降順、上限あり)。
   * failed/cancelled の表示と再送導線に使う (spec §3.4)。
   */
  recent_jobs: z.array(AgentJobSchema),
});
export type WorkDetailResponse = z.infer<typeof WorkDetailResponseSchema>;

/** POST /api/works/:id/messages — 送信→orchestrator_turn をキュー。 */
export const CreateMessageRequestSchema = z.object({
  content: z.string().min(1).max(20000),
  /** 使うキー (省略時は作品設定→ユーザーの最新キー)。 */
  key_id: z.string().optional(),
  /** モデル名 (省略時は作品設定→プロバイダー既定)。 */
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
  /** 蓄積済みの正典メモ (重複提案・再質問を防ぐため入力に含める)。 */
  canon_facts: z.array(CanonFactSchema),
  /** 未決定の提案 (pending のみ)。 */
  proposals: z.array(ProposalSchema),
  /** workspace のファイル一覧 (エージェントが見ている景色。一覧+要約のみ)。 */
  workspace_files: z.array(WorkspaceFileSchema),
  /** /plan/tree.md の内容 (planner の入力にも使う)。 */
  plan_tree: z.string(),
  /** 登場要素一覧 (現行行+別名。entity ops の参照と POV 解決に使う)。 */
  entities: z.array(EntityWithAliasesSchema).default([]),
});
export type ThreadContextResponse = z.infer<typeof ThreadContextResponseSchema>;

/** POST /api/internal/proposals — orchestrator が立てる提案の作成。 */
export const CreateProposalRequestSchema = z.object({
  work_id: z.string().min(1),
  thread_id: z.string().min(1),
  message_id: z.string().min(1),
  kind: z.string().min(1),
  payload: z.record(z.unknown()),
});
export type CreateProposalRequest = z.infer<typeof CreateProposalRequestSchema>;

export const ProposalResponseSchema = z.object({
  proposal: ProposalSchema,
});
export type ProposalResponse = z.infer<typeof ProposalResponseSchema>;

/**
 * 正典メモの追加入力 1 件。文字列だけなら commitment=fixed/disclosure=normal。
 */
export const CanonFactInputSchema = z.union([
  z.string().min(1),
  z.object({
    statement: z.string().min(1),
    commitment: CommitmentLevelSchema.optional(),
    disclosure: DisclosurePolicySchema.optional(),
  }),
]);
export type CanonFactInput = z.infer<typeof CanonFactInputSchema>;

/** POST /api/internal/works/:id/canon-facts — 正典メモ追加 (完全一致は重複スキップ)。 */
export const AddCanonFactsRequestSchema = z.object({
  statements: z.array(CanonFactInputSchema).min(1).max(50),
  provenance: z.string().min(1),
});
export type AddCanonFactsRequest = z.infer<typeof AddCanonFactsRequestSchema>;

export const CanonFactsResponseSchema = z.object({
  canon_facts: z.array(CanonFactSchema),
  /** 実際に追加された件数 (重複スキップ後)。 */
  added: z.number().int(),
});
export type CanonFactsResponse = z.infer<typeof CanonFactsResponseSchema>;

/** GET /api/internal/scenes/:id/context — generate_scene の入力材料。 */
export const SceneContextResponseSchema = z.object({
  scene: SceneSchema,
  /** 最新の writing_contract (approved ゲートは runner 側でも再検証)。 */
  contract: WritingContractSchema.nullable(),
  work: WorkSchema,
  canon_facts: z.array(CanonFactSchema),
  /** 同一作品でこのシーンより前のシーン本文の抜粋。 */
  prev_scenes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      excerpt: z.string(),
    }),
  ),
  /** 登場要素一覧 (言及検出と POV 知識解決に使う。現行行+別名)。 */
  entities: z.array(EntityWithAliasesSchema).default([]),
  /** 現行の知識イベント (誰が何を知ったか。POV 知識の解決に使う)。 */
  knowledge_events: z.array(KnowledgeEventSchema).default([]),
});
export type SceneContextResponse = z.infer<typeof SceneContextResponseSchema>;

/** POST /api/internal/scenes/:id/revisions — AI生成リビジョンの永続化。 */
export const PersistRevisionRequestSchema = z.object({
  content_json: z.unknown(),
  source: RevisionSourceSchema,
  /** 生成ジョブ由来なら job.id、手編集なら null。 */
  job_id: z.string().min(1).nullable(),
});
export type PersistRevisionRequest = z.infer<
  typeof PersistRevisionRequestSchema
>;

export const SceneRevisionResponseSchema = z.object({
  revision: SceneRevisionSchema,
});
export type SceneRevisionResponse = z.infer<
  typeof SceneRevisionResponseSchema
>;

// ---------------------------------------------------------------------------
// API: Phase 1b ユーザー向け (セッション認証)
// ---------------------------------------------------------------------------

/** POST /api/proposals/:id/approve の応答。 */
export const ApproveProposalResponseSchema = z.object({
  proposal: ProposalSchema,
  episode: EpisodeSchema,
  scene: SceneSchema,
  contract: WritingContractSchema,
  job: AgentJobSchema,
});
export type ApproveProposalResponse = z.infer<
  typeof ApproveProposalResponseSchema
>;

/** GET /api/works/:id/prose — 本文タブのデータ一式。 */
export const WorkProseResponseSchema = z.object({
  episodes: z.array(EpisodeSchema),
  scenes: z.array(SceneSchema),
  revisions: z.array(SceneRevisionSchema),
  contracts: z.array(WritingContractSchema),
  canon_facts: z.array(CanonFactSchema),
});
export type WorkProseResponse = z.infer<typeof WorkProseResponseSchema>;

/** POST /api/scenes/:id/rewrite — 指示つき再生成 (新リビジョン)。 */
export const RewriteSceneRequestSchema = z.object({
  instruction: z.string().min(1).max(4000),
});
export type RewriteSceneRequest = z.infer<typeof RewriteSceneRequestSchema>;

/** POST /api/scenes/:id/revisions — 手編集による新リビジョン (spec §5.5)。 */
export const CreateRevisionRequestSchema = z.object({
  text: z.string().min(1).max(200000),
});
export type CreateRevisionRequest = z.infer<typeof CreateRevisionRequestSchema>;

/** POST /api/works/:id/settings — provider/model/key の選択。 */
export const WorkSettingsRequestSchema = z.object({
  /** 使うキー (自分のキーのみ。null で解除→既定解決)。 */
  key_id: z.string().nullable().optional(),
  model: z.string().min(1).max(200).optional(),
});
export type WorkSettingsRequest = z.infer<typeof WorkSettingsRequestSchema>;

// ---------------------------------------------------------------------------
// Tiptap doc 変換 (本文の正本フォーマット, spec §8.1)
// ---------------------------------------------------------------------------

/**
 * 生成テキストを Tiptap doc JSON に変換する。
 * 段落 = 非空の行 (日本語の小説本文は行=段落が基本)。
 */
export function textToTiptapDoc(text: string): Record<string, unknown> {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    type: "doc",
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: [{ type: "text", text: p }],
    })),
  };
}

/** Tiptap doc JSON → プレーンテキスト (表示・手編集の textarea 用)。 */
export function tiptapDocToText(doc: unknown): string {
  if (
    !doc ||
    typeof doc !== "object" ||
    !Array.isArray((doc as { content?: unknown[] }).content)
  ) {
    return "";
  }
  const paras: string[] = [];
  for (const node of (doc as { content: unknown[] }).content) {
    if (!node || typeof node !== "object") continue;
    const inner = (node as { content?: unknown[] }).content;
    if (!Array.isArray(inner)) continue;
    const text = inner
      .map((c) =>
        c && typeof c === "object"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
    paras.push(text);
  }
  return paras.join("\n\n");
}

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
  /** StoryCharter / NarrativePolicy の確定内容 (spec §4.1, §6.1)。 */
  charter: z.record(z.unknown()).optional(),
  policy: z.record(z.unknown()).optional(),
});
export type WorkPatchRequest = z.infer<typeof WorkPatchRequestSchema>;

// ---------------------------------------------------------------------------
// Phase 2b: 変更セット + 影響分析 + 正典リビジョン (spec §5, §5.5, §6.3, §3)
// ---------------------------------------------------------------------------

/**
 * 変更セットの種別 (force_override = 強制適用の記録, spec §5.4;
 * revision = review_change の findings から自動生成した修正候補)。
 */
export const CHANGE_SET_KINDS = [
  "normal",
  "manual_edit",
  "force_override",
  "revision",
] as const;
export const ChangeSetKindSchema = z.enum(CHANGE_SET_KINDS);
export type ChangeSetKind = z.infer<typeof ChangeSetKindSchema>;

/** 変更セットの状態 (proposed → approve→applied / reject→rejected)。 */
export const CHANGE_SET_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "applied",
] as const;
export const ChangeSetStatusSchema = z.enum(CHANGE_SET_STATUSES);
export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;

/** update_work op のパッチ (構造情報のみ。status は変更不可)。 */
export const ChangeSetWorkPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  premise: z.string().max(20000).optional(),
  genre: z.string().max(200).optional(),
  charter: z.record(z.unknown()).optional(),
  policy: z.record(z.unknown()).optional(),
});
export type ChangeSetWorkPatch = z.infer<typeof ChangeSetWorkPatchSchema>;

/** 変更セットの操作 (spec §5.1 の ops 語彙)。 */
export const ChangeSetOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("retire_fact"), fact_id: z.string().min(1) }),
  z.object({
    op: z.literal("revise_fact"),
    fact_id: z.string().min(1),
    new_statement: z.string().min(1).max(20000),
    /** 省略時は旧行の値を引き継ぐ (commitment/disclosure もリビジョンの一部)。 */
    commitment: CommitmentLevelSchema.optional(),
    disclosure: DisclosurePolicySchema.optional(),
    /** 関連エンティティの entity_id (安定ID)。省略時は旧行のリンクを引き継ぐ。 */
    entity_refs: z.array(z.string().min(1)).max(50).optional(),
  }),
  z.object({
    op: z.literal("add_fact"),
    statement: z.string().min(1).max(20000),
    commitment: CommitmentLevelSchema.optional(),
    disclosure: DisclosurePolicySchema.optional(),
    /** 関連エンティティの entity_id (安定ID)。 */
    entity_refs: z.array(z.string().min(1)).max(50).optional(),
  }),
  /**
   * 正典メモのコミットメント状態だけを変更する (spec §4.3)。
   * statement は変えず、確度/開示の更新を新リビジョンとして記録する。
   */
  z.object({
    op: z.literal("set_fact_commitment"),
    fact_id: z.string().min(1),
    commitment: CommitmentLevelSchema,
    disclosure: DisclosurePolicySchema.optional(),
  }),
  z.object({
    op: z.literal("update_work"),
    patch: ChangeSetWorkPatchSchema,
  }),
  /** シーン本文の書き換え (新リビジョンとして適用。修正提案で使う)。 */
  z.object({
    op: z.literal("rewrite_scene"),
    scene_id: z.string().min(1),
    text: z.string().min(1).max(200000),
  }),
  /** 登場要素の追加 (spec §6.4)。 */
  z.object({
    op: z.literal("add_entity"),
    kind: EntityKindSchema,
    name: z.string().min(1).max(200),
    summary: z.string().max(20000).default(""),
    /** 別名・表記揺れ・愛称 (省略可)。 */
    aliases: z.array(z.string().min(1).max(200)).max(50).default([]),
  }),
  /** 登場要素の更新 (時系列: 旧行を閉じて新行を挿入)。 */
  z.object({
    op: z.literal("update_entity"),
    /** 安定ID側 (entity_id)。 */
    entity_id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    summary: z.string().max(20000).optional(),
    add_aliases: z.array(z.string().min(1).max(200)).max(50).optional(),
    remove_aliases: z.array(z.string().min(1).max(200)).max(50).optional(),
  }),
  /** 登場要素の廃止 (valid_to_rev 設定。登場しなくなった・設定変更等)。 */
  z.object({
    op: z.literal("retire_entity"),
    entity_id: z.string().min(1),
  }),
  /** 知識イベントの記録 (誰が何を・どこから知ったか)。 */
  z.object({
    op: z.literal("add_knowledge_event"),
    /** 知った人物の entity_id (安定ID)。 */
    entity_id: z.string().min(1),
    /** 何を知ったか: 正典の id または fact_ref (fact_ref に解決される)。 */
    fact_id: z.string().min(1),
    /** どこで知ったか (scenes.id。任意)。 */
    scene_id: z.string().min(1).optional(),
    /** 情報源 (目撃/伝聞/推論/記述 など)。 */
    source: z.string().min(1).max(200).default("記述"),
  }),
  /** 知識イベントの取消 (valid_to_rev 設定)。 */
  z.object({
    op: z.literal("retract_knowledge_event"),
    event_id: z.string().min(1),
  }),
]);
export type ChangeSetOp = z.infer<typeof ChangeSetOpSchema>;

/** 影響分析の結果 (決定的 MVP: ops から影響対象を列挙, spec §3)。 */
export const ChangeSetImpactSchema = z.object({
  scenes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      reason: z.string().default(""),
    }),
  ),
  facts: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      reason: z.string().default(""),
    }),
  ),
  contracts: z.array(
    z.object({
      id: z.string(),
      scene_id: z.string(),
      reason: z.string().default(""),
    }),
  ),
  /** 影響を受ける登場要素 (entity ops の対象 + fact 経路で繋がる要素)。 */
  entities: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  /** 人間向けサマリー文 (例: "シーン2件・正典1件・契約2件に影響する可能性")。 */
  summary: z.string().default(""),
});
export type ChangeSetImpact = z.infer<typeof ChangeSetImpactSchema>;

/** 適用前検査の1項目 (spec §5.3 step 6-8)。 */
export const PreApplyCheckItemSchema = z.object({
  /**
   * 検査種別。impact_grew=影響範囲の拡大 / missing_ref=参照先の消失 /
   * stale_fact=正典の改定済み / contract_check=本文の決定的検査 (info 相当) /
   * contract_violation=本文の決定的検査での違反。
   */
  kind: z.string().min(1),
  /** 人向け説明 (日本語)。 */
  detail: z.string(),
});
export type PreApplyCheckItem = z.infer<typeof PreApplyCheckItemSchema>;

/**
 * 適用前検査の結果 (change_sets.pre_apply_check)。
 * 通常承認の直前に実施し、D1 単一ストアで「一時ブランチでの検査」を
 * 代替する同期検証 (spec §5.3 step 6)。force 適用 (§5.4) では実施しない。
 */
export const PreApplyCheckSchema = z.object({
  /** 検査を実行した時刻。 */
  checked_at: z.number(),
  /** 適用は通るが注意が要るもの (影響範囲の拡大・info 相当の本文検査)。 */
  warnings: z.array(PreApplyCheckItemSchema),
  /** 通常承認を保留にする違反 (参照先の消失・契約違反)。 */
  violations: z.array(PreApplyCheckItemSchema),
});
export type PreApplyCheck = z.infer<typeof PreApplyCheckSchema>;

export const ChangeSetSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  kind: ChangeSetKindSchema,
  title: z.string(),
  description: z.string(),
  ops: z.array(ChangeSetOpSchema),
  status: ChangeSetStatusSchema,
  impact: ChangeSetImpactSchema,
  /** 通常承認の直前に実行した適用前検査 (spec §5.3)。未実施は null。 */
  pre_apply_check: PreApplyCheckSchema.nullable(),
  /** force 適用で 1 (spec §5.4)。 */
  force: z.number().int(),
  /** 強制適用時に記録した変更理由 (spec §5.4)。 */
  force_reason: z.string().nullable(),
  /** 提案時点の canon_rev。適用時の楽観的競合検出に使う (spec §8.3)。 */
  base_rev: z.number().int().nullable(),
  /** この提案を出したチャットメッセージ (カード紐付け)。 */
  message_id: z.string().nullable(),
  /**
   * charter/policy を変える update_work op 適用時に退避した
   * 適用前の works.charter/policy。それ以外の変更セットは null
   * (docs/gaps.md「変更前スナップショットの保持」)。
   */
  prev_settings: z
    .object({
      charter: z.unknown().nullable(),
      policy: z.unknown().nullable(),
    })
    .nullable(),
  created_at: z.number(),
  decided_at: z.number().nullable(),
  applied_at: z.number().nullable(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/** review_findings: 変更適用後レビューで記録された衝突・補足。 */
export const ReviewFindingSchema = z.object({
  id: z.string(),
  change_set_id: z.string(),
  /** conflict=新正典との衝突, info=補足。 */
  kind: z.string().min(1),
  severity: z.string().min(1),
  summary: z.string(),
  detail: z.string(),
  scene_id: z.string().nullable(),
  fact_id: z.string().nullable(),
  status: z.enum(["open", "dismissed"]),
  created_at: z.number(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ChangeSetWithFindingsSchema = ChangeSetSchema.extend({
  findings: z.array(ReviewFindingSchema),
});
export type ChangeSetWithFindings = z.infer<typeof ChangeSetWithFindingsSchema>;

// --- API: internal (orchestrator CHANGESET マーカー / review_change ジョブ) ---

/** POST /api/internal/works/:id/change-sets — 提案状態の変更セット作成+影響分析。 */
export const CreateChangeSetRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20000).default(""),
  ops: z.array(ChangeSetOpSchema).min(1).max(100),
  message_id: z.string().min(1).nullable().optional(),
  /** 起票種別。省略時 normal。revision は review_change の修正提案のみ。 */
  kind: z.enum(["normal", "revision"]).default("normal"),
});
export type CreateChangeSetRequest = z.infer<typeof CreateChangeSetRequestSchema>;

export const ChangeSetResponseSchema = z.object({
  change_set: ChangeSetWithFindingsSchema,
});
export type ChangeSetResponse = z.infer<typeof ChangeSetResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 3a: 公開リリース (spec §6 Release, P9: 公開版と執筆中の真実を分離)
// ---------------------------------------------------------------------------

/** リリースの状態。published=公開中 / unlisted=取り下げ済み (reader で 404)。 */
export const ReleaseStatusSchema = z.enum(["published", "unlisted"]);
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

/** リリース本文の 1 シーン (発行時点の最新リビジョンをコピーして凍結)。 */
export const ReleaseSceneSchema = z.object({
  scene_ord: z.number().int(),
  scene_title: z.string(),
  prose_md: z.string(),
});
export type ReleaseScene = z.infer<typeof ReleaseSceneSchema>;

/**
 * 話単位の不変公開スナップショット (spec §6.3: 発行時点の正典リビジョンを指す)。
 * 発行後に本文を改稿・正典を変更しても、この行は書き換わらない。
 */
export const ReleaseSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  episode_id: z.string(),
  /** その話のリリース通し番号 (1 始まり)。 */
  rev_no: z.number().int(),
  /** 発行時点の works.canon_rev。 */
  canon_rev: z.number().int(),
  /** 公開時点の話タイトル。 */
  title: z.string(),
  /** 凍結した本文 (話のシーンを順に)。 */
  content: z.array(ReleaseSceneSchema),
  status: ReleaseStatusSchema,
  published_at: z.number(),
  created_at: z.number(),
});
export type Release = z.infer<typeof ReleaseSchema>;

/** POST /api/works/:id/episodes/:epId/releases の応答。 */
export const ReleaseResponseSchema = z.object({
  release: ReleaseSchema,
});
export type ReleaseResponse = z.infer<typeof ReleaseResponseSchema>;

/** GET /api/works/:id/releases — 公開タブのデータ一式 (owner のみ)。 */
export const WorkReleasesResponseSchema = z.object({
  episodes: z.array(
    z.object({
      id: z.string(),
      ord: z.number().int(),
      title: z.string(),
      /** 本文リビジョンが 1 件以上あるか (公開に必要)。 */
      has_prose: z.boolean(),
      /** 最新の公開以降に本文が変わっているか (未公開の変更あり)。 */
      dirty: z.boolean(),
    }),
  ),
  releases: z.array(ReleaseSchema),
});
export type WorkReleasesResponse = z.infer<typeof WorkReleasesResponseSchema>;

/**
 * GET /api/r/:id — 読者向けの公開リリース。
 * spec P9/§9: タイトル・話名・本文・公開日だけを返し、
 * 正典・ユーザー情報・下書きは絶対に含めない。
 */
export const PublicReleaseSchema = z.object({
  id: z.string(),
  work_title: z.string(),
  /** 話タイトル (公開時点)。 */
  title: z.string(),
  rev_no: z.number().int(),
  published_at: z.number(),
  scenes: z.array(ReleaseSceneSchema),
});
export type PublicRelease = z.infer<typeof PublicReleaseSchema>;

export const PublicReleaseResponseSchema = z.object({
  release: PublicReleaseSchema,
});
export type PublicReleaseResponse = z.infer<typeof PublicReleaseResponseSchema>;

/**
 * GET /api/w/:id — 読者向けの作品公開目次。
 * spec P9/§9: タイトル・あらすじ・公開話の一覧だけを返し、
 * 正典・下書き・ユーザー情報・canon_rev は絶対に含めない。
 */
export const PublicWorkEpisodeSchema = z.object({
  episode_id: z.string(),
  ord: z.number().int(),
  /** 話タイトル (最新公開版の発行時点)。 */
  title: z.string(),
  /** その話の published リリース数 (版の履歴)。 */
  version_count: z.number().int(),
  /** 最新 published リリース。 */
  release_id: z.string(),
  rev_no: z.number().int(),
  published_at: z.number(),
});
export type PublicWorkEpisode = z.infer<typeof PublicWorkEpisodeSchema>;

export const PublicWorkSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** あらすじ (空文字なら未設定)。 */
  premise: z.string(),
});
export type PublicWork = z.infer<typeof PublicWorkSchema>;

export const PublicWorkResponseSchema = z.object({
  work: PublicWorkSchema,
  episodes: z.array(PublicWorkEpisodeSchema),
});
export type PublicWorkResponse = z.infer<typeof PublicWorkResponseSchema>;

/** GET /api/internal/change-sets/:id/context — review_change の入力材料。 */
export const ChangeSetContextResponseSchema = z.object({
  change_set: ChangeSetWithFindingsSchema,
  work: WorkSchema,
  thread_id: z.string(),
  /** 適用後の現行正典。 */
  canon_facts: z.array(CanonFactSchema),
  /** 影響対象シーン (最新リビジョン本文 + 最新契約)。 */
  scenes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      prose_md: z.string(),
      contract: WritingContractPayloadSchema.nullable(),
    }),
  ),
});
export type ChangeSetContextResponse = z.infer<
  typeof ChangeSetContextResponseSchema
>;

/** POST /api/internal/change-sets/:id/findings — review_change の記録。 */
export const RecordReviewFindingsRequestSchema = z.object({
  findings: z
    .array(
      z.object({
        kind: z.string().min(1).max(50),
        severity: z.string().min(1).max(20),
        summary: z.string().min(1).max(500),
        detail: z.string().max(20000).default(""),
        scene_id: z.string().min(1).nullable().optional(),
        fact_id: z.string().min(1).nullable().optional(),
      }),
    )
    .max(500),
});
export type RecordReviewFindingsRequest = z.infer<
  typeof RecordReviewFindingsRequestSchema
>;

export const RecordReviewFindingsResponseSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  /** 実際に追加された件数 (重複スキップ後)。 */
  added: z.number().int(),
});
export type RecordReviewFindingsResponse = z.infer<
  typeof RecordReviewFindingsResponseSchema
>;

// --- API: ユーザー向け ---

/** POST /api/change-sets/:id/approve — {force:true} で force_override 昇格。 */
export const ApproveChangeSetRequestSchema = z.object({
  force: z.boolean().optional(),
  /** 強制適用の理由 (spec §5.4)。force=true では必須。 */
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type ApproveChangeSetRequest = z.infer<
  typeof ApproveChangeSetRequestSchema
>;

export const ApproveChangeSetResponseSchema = z.object({
  change_set: ChangeSetWithFindingsSchema,
  /** 起票した review_change ジョブ (キー未設定などで起票なしは null)。 */
  job: AgentJobSchema.nullable(),
  /** 実施した適用前検査 (通常承認時。force 適用・検査未実施は null)。 */
  pre_apply_check: PreApplyCheckSchema.nullable(),
});
export type ApproveChangeSetResponse = z.infer<
  typeof ApproveChangeSetResponseSchema
>;

/** GET /api/works/:id/changes — 変更タブ用の一式。 */
export const WorkChangesResponseSchema = z.object({
  change_sets: z.array(ChangeSetWithFindingsSchema),
});
export type WorkChangesResponse = z.infer<typeof WorkChangesResponseSchema>;

/** POST /api/review-findings/:id/status — open/dismissed 切替。 */
export const SetFindingStatusRequestSchema = z.object({
  status: z.enum(["open", "dismissed"]),
});
export type SetFindingStatusRequest = z.infer<
  typeof SetFindingStatusRequestSchema
>;

export const ReviewFindingResponseSchema = z.object({
  finding: ReviewFindingSchema,
});
export type ReviewFindingResponse = z.infer<typeof ReviewFindingResponseSchema>;

// --- review_change ジョブ ---

export const ReviewChangeCheckpointSchema = z.object({
  /** scene_id -> critic 出力 (途中再開用)。 */
  reviews: z.record(z.unknown()).optional(),
  findings_recorded: z.boolean().optional(),
  message_id: z.string().optional(),
  /** 修正提案スキルの出力 ops (再開時にスキル再実行しないため保持)。 */
  fix_ops: z.array(z.unknown()).optional(),
  /** 修正提案変更セットの description (再開時に保持)。 */
  fix_description: z.string().optional(),
  /** 生成した修正提案変更セットの id。 */
  fix_change_set_id: z.string().optional(),
});
export type ReviewChangeCheckpoint = z.infer<
  typeof ReviewChangeCheckpointSchema
>;

export const ReviewChangePayloadSchema = z.object({
  change_set_id: z.string().min(1),
  work_id: z.string().min(1),
  user_ref: z.string().min(1),
  key_ref: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  checkpoint: ReviewChangeCheckpointSchema.optional(),
});
export type ReviewChangePayload = z.infer<typeof ReviewChangePayloadSchema>;

export const ReviewChangeResultSchema = z.object({
  kind: z.literal(JOB_KIND_REVIEW_CHANGE),
  change_set_id: z.string(),
  scenes_reviewed: z.number().int(),
  findings_count: z.number().int(),
  /** 自動生成した修正提案変更セット (無ければ null)。 */
  fix_change_set_id: z.string().nullable(),
});
export type ReviewChangeResult = z.infer<typeof ReviewChangeResultSchema>;
