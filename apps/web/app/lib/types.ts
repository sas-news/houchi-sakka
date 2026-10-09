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

export interface WorkDetail {
  work: WorkInfo;
  thread: { id: string; work_id: string };
  messages: ChatMessageInfo[];
  active_job: { job: JobInfo; progress: ProgressEventInfo[] } | null;
  queued_jobs: number;
}
