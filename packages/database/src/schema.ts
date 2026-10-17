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

/**
 * spec §7.4 AgentStep — ジョブ内の実行ステップ記録。
 * progress_events (UI 表示用) と別に、監査・再開のための永続記録。
 */
export const agentSteps = sqliteTable(
  "agent_steps",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    /** ok | error。 */
    status: text("status").notNull().default("ok"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at").notNull(),
    model: text("model"),
    provider: text("provider"),
    /** 使用量 JSON ('unknown' 文字列もあり得る, spec §7.4)。 */
    usageJson: text("usage_json"),
    /** 成果物参照 JSON ({kind, id} など)。 */
    artifactJson: text("artifact_json"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("agent_steps_job_seq_uq").on(t.jobId, t.seq),
    index("agent_steps_job_idx").on(t.jobId),
  ],
);

export const providerKeys = sqliteTable("provider_keys", {
  id: text("id").primaryKey(),
  ownerRef: text("owner_ref").notNull(),
  label: text("label").notNull(),
  provider: text("provider").notNull().default("openai"),
  /** OpenAI 互換のカスタムエンドポイント (spec §9。null = プリセット側)。 */
  baseUrl: text("base_url"),
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
    /** 自律運転レベル (spec §7.2: off | draft)。 */
    autonomyLevel: text("autonomy_level").notNull().default("off"),
    /** 自律継続の残り往復数 (spec §7.3 実行上限)。 */
    autonomyBudget: integer("autonomy_budget").notNull().default(0),
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
    /** コミットメント状態 (spec §4.3): fixed/committed/provisional/open_by_design/undecided。 */
    commitment: text("commitment").notNull().default("fixed"),
    /** 開示ポリシー (spec §4.3): normal/secret。 */
    disclosure: text("disclosure").notNull().default("normal"),
    provenance: text("provenance").notNull(),
    /** この行が現行になった正典リビジョン (spec §6.3。無バージョン追加は NULL)。 */
    validFromRev: integer("valid_from_rev"),
    /** 閉じられた正典リビジョン (NULL=現行)。 */
    validToRev: integer("valid_to_rev"),
    /**
     * リビジョン跨ぎの安定ID (spec §6.4)。revise/set_commitment で新行になる
     * 際に引き継がれる。エンティティリンク・知識イベントはこちらを指す。
     * 0009 より前の既存行は id と同じ値。
     */
    factRef: text("fact_ref"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("canon_facts_work_idx").on(t.workId),
    index("canon_facts_fact_ref_idx").on(t.factRef),
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
    /** 強制適用時の変更理由 (spec §5.4)。 */
    forceReason: text("force_reason"),
    /** 提案時点の works.canon_rev (楽観的競合検出, spec §8.3)。 */
    baseRev: integer("base_rev"),
    /** 提案を出したチャットメッセージ (カード紐付け)。 */
    messageId: text("message_id"),
    /**
     * charter/policy を変える update_work op 適用時に退避した
     * 適用前の値 ({charter, policy} の JSON。それ以外は NULL)。
     */
    prevSettings: text("prev_settings"),
    /**
     * 通常承認の直前に実行した適用前検査の結果
     * ({checked_at, warnings, violations} の JSON。未実施は NULL)。
     */
    preApplyCheck: text("pre_apply_check"),
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
// Phase 3a: 公開リリース (spec §6 Release — 話単位の不変スナップショット)
// ---------------------------------------------------------------------------

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    episodeId: text("episode_id").notNull(),
    /** その話のリリース通し番号 (1 始まり)。 */
    revNo: integer("rev_no").notNull(),
    /** 発行時点の works.canon_rev (spec §6.3)。 */
    canonRev: integer("canon_rev").notNull(),
    /** 公開時点の話タイトル。 */
    title: text("title").notNull(),
    /** [{scene_ord, scene_title, prose_md}] — 発行時点の最新リビジョンをコピー凍結。 */
    contentJson: text("content_json").notNull(),
    /** published | unlisted */
    status: text("status").notNull().default("published"),
    publishedAt: integer("published_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("releases_episode_rev_uq").on(t.episodeId, t.revNo),
    index("releases_work_idx").on(t.workId),
    index("releases_episode_idx").on(t.episodeId),
  ],
);

// ---------------------------------------------------------------------------
// 知識追跡 MVP (spec §6.3-6.4): StoryEntity + EntityAlias + fact_entities
// + KnowledgeEvent。id はリビジョン行のPK、entity_id/fact_ref は
// リビジョンを跨ぐ安定ID。
// ---------------------------------------------------------------------------

export const storyEntities = sqliteTable(
  "story_entities",
  {
    id: text("id").primaryKey(),
    /** リビジョンを跨ぐ安定ID (aliases/edges/knowledge_events はこちらを指す)。 */
    entityId: text("entity_id").notNull(),
    workId: text("work_id").notNull(),
    /** character | place | org | item | concept */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    validFromRev: integer("valid_from_rev"),
    validToRev: integer("valid_to_rev"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("story_entities_work_idx").on(t.workId),
    index("story_entities_entity_idx").on(t.entityId),
    // 同一作品内で同 kind+name の現行エンティティは1件まで
    uniqueIndex("story_entities_work_kind_name_uq")
      .on(t.workId, t.kind, t.name)
      .where(sql`valid_to_rev IS NULL`),
  ],
);

export const entityAliases = sqliteTable(
  "entity_aliases",
  {
    id: text("id").primaryKey(),
    /** 安定ID側 (entity_id) を指す。 */
    entityId: text("entity_id").notNull(),
    /** 別名・表記揺れ・愛称。 */
    alias: text("alias").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("entity_aliases_entity_idx").on(t.entityId),
    uniqueIndex("entity_aliases_entity_alias_uq").on(t.entityId, t.alias),
  ],
);

/** 正典とエンティティのリンク (spec §6.4「自然言語文+関連エンティティ」)。 */
export const factEntities = sqliteTable(
  "fact_entities",
  {
    /** canon_facts.fact_ref (安定ID) を指すので改定で切れない。 */
    factRef: text("fact_ref").notNull(),
    /** story_entities.entity_id (安定ID)。 */
    entityId: text("entity_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("fact_entities_fact_entity_uq").on(t.factRef, t.entityId),
    index("fact_entities_entity_idx").on(t.entityId),
  ],
);

export const knowledgeEvents = sqliteTable(
  "knowledge_events",
  {
    id: text("id").primaryKey(),
    workId: text("work_id").notNull(),
    /** 知った人物の entity_id (安定ID)。 */
    entityId: text("entity_id").notNull(),
    /** 何を知ったか: canon_facts.fact_ref (安定ID)。 */
    factId: text("fact_id").notNull(),
    /** どこで知ったか (scenes.id。任意)。 */
    sceneId: text("scene_id"),
    /** 情報源: 目撃/伝聞/推論/記述 など (TEXT 自由)。 */
    source: text("source").notNull().default("記述"),
    validFromRev: integer("valid_from_rev"),
    validToRev: integer("valid_to_rev"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("knowledge_events_work_idx").on(t.workId),
    index("knowledge_events_entity_idx").on(t.entityId),
    index("knowledge_events_fact_idx").on(t.factId),
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
