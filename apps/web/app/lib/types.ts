/** API レスポンスの型 (contracts と対応。UI 側は構造だけ使う)。 */

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface KeyInfo {
  id: string;
  owner_ref: string;
  label: string;
  provider: string;
  created_at: number;
  /** このキーを参照している作品数 (削除時の影響表示)。 */
  works_using?: number;
}

export interface WorkInfo {
  id: string;
  owner_ref: string;
  title: string;
  premise: string;
  genre: string;
  status: "setup" | "active";
  charter: unknown | null;
  policy: unknown | null;
  provider: string | null;
  model: string | null;
  key_ref: string | null;
  canon_rev: number;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageInfo {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  job_id: string | null;
  created_at: number;
}

export interface JobInfo {
  id: string;
  kind: string;
  status: "queued" | "leased" | "completed" | "failed" | "cancelled";
  /** 実行体が記録した失敗理由。 */
  error: string | null;
  /** ジョブの入力 (trigger_message_id / key_ref / model 等)。 */
  payload: Record<string, unknown>;
  created_at: number;
}

export interface ProgressEventInfo {
  id: string;
  seq: number;
  type: "status" | "token" | "note";
  data: unknown;
}

export interface ProposalInfo {
  id: string;
  work_id: string;
  thread_id: string;
  /** 提案が表示される assistant メッセージ。 */
  message_id: string;
  kind: string;
  payload: {
    episode_title?: string;
    scene_title?: string;
    scene_purpose?: string;
    contract?: {
      role?: string;
      pov?: string;
      required_events?: string[];
      forbidden?: string[];
      knowledge_notes?: string;
      connections?: string;
    };
    episode_id?: string;
    scene_id?: string;
    contract_id?: string;
    /** kind="plan": 計画の話・シーン構成案。 */
    episodes?: { title: string; scenes: { title: string; purpose?: string }[] }[];
    /** kind="workspace_write": 書き込み先パスと内容。 */
    path?: string;
    content?: string;
    supported?: boolean;
  };
  status: "pending" | "approved" | "rejected";
  decided_at: number | null;
  created_at: number;
}

export interface EpisodeInfo {
  id: string;
  work_id: string;
  ord: number;
  title: string;
  status: string;
}

export interface SceneInfo {
  id: string;
  episode_id: string;
  ord: number;
  title: string;
  purpose: string;
  status: "draft" | "proposed" | "approved" | "generated";
  created_at: number;
  updated_at: number;
}

export interface SceneRevisionInfo {
  id: string;
  scene_id: string;
  rev_no: number;
  content_json: unknown;
  source: "ai" | "manual_edit";
  job_id: string | null;
  change_set_id: string | null;
  created_at: number;
}

export interface WritingContractInfo {
  id: string;
  scene_id: string;
  status: "draft" | "approved" | "rejected";
  payload: {
    role?: string;
    pov?: string;
    required_events?: string[];
    forbidden?: string[];
    knowledge_notes?: string;
    connections?: string;
  };
}

export interface CanonFactInfo {
  id: string;
  work_id: string;
  statement: string;
  /** コミットメント状態 (spec §4.3)。 */
  commitment: "fixed" | "committed" | "provisional" | "open_by_design" | "undecided";
  /** 開示ポリシー (spec §4.3)。 */
  disclosure: "normal" | "secret";
  provenance: string;
  created_at: number;
}

export interface ChangeSetOp {
  op:
    | "retire_fact"
    | "revise_fact"
    | "add_fact"
    | "set_fact_commitment"
    | "update_work"
    | "rewrite_scene";
  fact_id?: string;
  new_statement?: string;
  statement?: string;
  /** 正典の確度・開示 (add_fact/revise_fact/set_fact_commitment)。 */
  commitment?: CanonFactInfo["commitment"];
  disclosure?: CanonFactInfo["disclosure"];
  patch?: Partial<
    Pick<WorkInfo, "title" | "premise" | "genre" | "charter" | "policy">
  >;
  /** rewrite_scene: 対象シーンと書き換え後の本文。 */
  scene_id?: string;
  text?: string;
}

export interface ChangeSetImpact {
  scenes: { id: string; title: string; reason: string }[];
  facts: { id: string; statement: string; reason: string }[];
  contracts: { id: string; scene_id: string; reason: string }[];
  summary: string;
}

/** 適用前検査の1項目 (spec §5.3 step 6-8)。 */
export interface PreApplyCheckItemInfo {
  kind: string;
  detail: string;
}

/** 通常承認の直前に実行した適用前検査 (force 適用・未実施は null)。 */
export interface PreApplyCheckInfo {
  checked_at: number;
  warnings: PreApplyCheckItemInfo[];
  violations: PreApplyCheckItemInfo[];
}

export interface ReviewFindingInfo {
  id: string;
  change_set_id: string;
  kind: "conflict" | "info";
  severity: "low" | "medium" | "high";
  summary: string;
  detail: string;
  scene_id: string | null;
  fact_id: string | null;
  status: "open" | "dismissed";
  created_at: number;
}

export interface ChangeSetInfo {
  id: string;
  work_id: string;
  thread_id: string | null;
  /** <<CHANGESET>> を出した assistant メッセージ (提案カードの紐付け)。 */
  message_id: string | null;
  kind: "normal" | "manual_edit" | "force_override" | "revision";
  title: string;
  description: string;
  ops: ChangeSetOp[];
  status: "proposed" | "approved" | "rejected" | "applied";
  impact: ChangeSetImpact;
  /** 強制適用なら 1 (DB INTEGER)。 */
  force: number;
  /** 強制適用時に記録した理由 (spec §5.4)。 */
  force_reason: string | null;
  /** 提案時点の canon_rev (spec §8.3 楽観的競合検出)。 */
  base_rev: number | null;
  /** charter/policy 更新の適用時に退避した旧値 (なければ null)。 */
  prev_settings: { charter: unknown | null; policy: unknown | null } | null;
  /** 通常承認の直前に実行した適用前検査 (未実施は null)。 */
  pre_apply_check: PreApplyCheckInfo | null;
  findings: ReviewFindingInfo[];
  created_at: number;
  decided_at: number | null;
  applied_at: number | null;
}

export interface WorkDetail {
  work: WorkInfo;
  thread: { id: string; work_id: string };
  messages: ChatMessageInfo[];
  proposals: ProposalInfo[];
  change_sets: ChangeSetInfo[];
  active_job: { job: JobInfo; progress: ProgressEventInfo[] } | null;
  queued_jobs: number;
  /** 実行履歴 (全 status、新しい順)。 */
  recent_jobs: JobInfo[];
}

export interface WorkProse {
  episodes: EpisodeInfo[];
  scenes: SceneInfo[];
  revisions: SceneRevisionInfo[];
  contracts: WritingContractInfo[];
  canon_facts: CanonFactInfo[];
}

/** 資料タブ: workspace 仮想ファイル。 */
export interface WorkspaceFileInfo {
  path: string;
  summary: string;
}

/** Phase 3a: 公開リリース (不変スナップショット)。 */
export interface ReleaseSceneInfo {
  scene_ord: number;
  scene_title: string;
  prose_md: string;
}

export interface ReleaseInfo {
  id: string;
  work_id: string;
  episode_id: string;
  rev_no: number;
  canon_rev: number;
  title: string;
  content: ReleaseSceneInfo[];
  status: "published" | "unlisted";
  published_at: number;
  created_at: number;
}

/** 公開タブの話行 (GET /api/works/:id/releases)。 */
export interface ReleaseEpisodeInfo {
  id: string;
  ord: number;
  title: string;
  /** 本文リビジョンが 1 件以上あるか。 */
  has_prose: boolean;
  /** 最新の公開以降に本文が変わっているか。 */
  dirty: boolean;
}

export interface WorkReleases {
  episodes: ReleaseEpisodeInfo[];
  releases: ReleaseInfo[];
}

/** GET /api/r/:id — 読者向け公開リリース (安全なフィールドのみ)。 */
export interface PublicReleaseInfo {
  id: string;
  work_title: string;
  title: string;
  rev_no: number;
  published_at: number;
  scenes: ReleaseSceneInfo[];
}

/** GET /api/w/:id — 読者向け作品目次 (安全なフィールドのみ)。 */
export interface PublicWorkEpisodeInfo {
  episode_id: string;
  ord: number;
  /** 話タイトル (最新公開版の発行時点)。 */
  title: string;
  /** その話の published リリース数。 */
  version_count: number;
  release_id: string;
  rev_no: number;
  published_at: number;
}

export interface PublicWorkInfo {
  id: string;
  title: string;
  premise: string;
}
