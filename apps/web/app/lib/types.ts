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
  error: string | null;
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
  provenance: string;
  created_at: number;
}

export interface ChangeSetOp {
  op: "retire_fact" | "revise_fact" | "add_fact" | "update_work";
  fact_id?: string;
  new_statement?: string;
  statement?: string;
  patch?: Partial<Pick<WorkInfo, "title" | "premise" | "genre">>;
}

export interface ChangeSetImpact {
  scenes: { id: string; title: string; reason: string }[];
  facts: { id: string; statement: string; reason: string }[];
  contracts: { id: string; scene_id: string; reason: string }[];
  summary: string;
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
  kind: "normal" | "manual_edit" | "force_override";
  title: string;
  description: string;
  ops: ChangeSetOp[];
  status: "proposed" | "approved" | "rejected" | "applied";
  impact: ChangeSetImpact;
  /** 強制適用なら 1 (DB INTEGER)。 */
  force: number;
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
