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
  /** StoryCharter (作品の狙い・制約) JSON。未作成は null (spec §6.1)。 */
  charter: z.unknown().nullable(),
  /** NarrativePolicy (執筆方式・計画先行範囲) JSON。未作成は null。 */
  policy: z.unknown().nullable(),
  /** この作品で使うプロバイダー/モデル/キー (未設定は null → 既定解決)。 */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  key_ref: z.string().nullable(),
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

/** 正典メモ (Phase 1b の最小版: 自然言語文 + 出所のみ, spec §6.4)。 */
export const CanonFactSchema = z.object({
  id: z.string(),
  work_id: z.string(),
  statement: z.string(),
  /** 出所 (例: "orchestrator", "author")。 */
  provenance: z.string(),
  created_at: z.number(),
});
export type CanonFact = z.infer<typeof CanonFactSchema>;

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
  /** 蓄積済みの正典メモ (重複提案・再質問を防ぐため入力に含める)。 */
  canon_facts: z.array(CanonFactSchema),
  /** 未決定の提案 (pending のみ)。 */
  proposals: z.array(ProposalSchema),
  /** workspace のファイル一覧 (エージェントが見ている景色。一覧+要約のみ)。 */
  workspace_files: z.array(WorkspaceFileSchema),
  /** /plan/tree.md の内容 (planner の入力にも使う)。 */
  plan_tree: z.string(),
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

/** POST /api/internal/works/:id/canon-facts — 正典メモ追加 (完全一致は重複スキップ)。 */
export const AddCanonFactsRequestSchema = z.object({
  statements: z.array(z.string().min(1)).min(1).max(50),
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
