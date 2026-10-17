import type {
  AgentStepInfo,
  ChangeSetInfo,
  ChatMessageInfo,
  JobInfo,
  KeyInfo,
  ProposalInfo,
  ReleaseInfo,
  ReviewFindingInfo,
  SceneRevisionInfo,
  WorkDetail,
  WorkInfo,
  WorkProse,
  WorkReleases,
  WorkspaceFileInfo,
  WorkEntityInfo,
} from "./types";

/** セッション Cookie 前提の小さな fetch ラッパー。 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  // セッション切れはその場でログイン画面へ (呼び出し元で個別処理しない)。
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.assign("/login");
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.error?.code ?? "http_error",
      data.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export const api = {
  getWork: (id: string) => call<WorkDetail>(`/api/works/${id}`),
  getProse: (id: string) => call<WorkProse>(`/api/works/${id}/prose`),
  listWorkspaceFiles: (id: string) =>
    call<{ files: WorkspaceFileInfo[] }>(`/api/works/${id}/workspace/files`),
  getEntities: (id: string) =>
    call<{ entities: WorkEntityInfo[] }>(`/api/works/${id}/entities`),
  getWorkspaceFile: (id: string, path: string) =>
    call<{ path: string; content: string }>(
      `/api/works/${id}/workspace/file?path=${encodeURIComponent(path)}`,
    ),
  listKeys: () => call<{ keys: KeyInfo[] }>("/api/keys"),
  decideProposal: (id: string, action: "approve" | "reject") =>
    call<{ proposal: ProposalInfo }>(`/api/proposals/${id}/${action}`, "POST"),
  rewriteScene: (sceneId: string, instruction: string) =>
    call<{ job: JobInfo }>(`/api/scenes/${sceneId}/rewrite`, "POST", {
      instruction,
    }),
  createRevision: (sceneId: string, text: string) =>
    call<{ revision: SceneRevisionInfo }>(
      `/api/scenes/${sceneId}/revisions`,
      "POST",
      { text },
    ),
  updateWorkSettings: (
    workId: string,
    input: { key_id?: string | null; model?: string },
  ) => call<{ work: WorkInfo }>(`/api/works/${workId}/settings`, "PATCH", input),
  getChanges: (id: string) =>
    call<{ change_sets: ChangeSetInfo[] }>(`/api/works/${id}/changes`),
  /** 変更セットの承認 (force=true で却下済み含め強制適用)。 */
  approveChangeSet: (id: string, force = false, reason?: string) =>
    call<{ change_set: ChangeSetInfo; job: JobInfo | null }>(
      `/api/change-sets/${id}/approve`,
      "POST",
      reason ? { force, reason } : { force },
    ),
  rejectChangeSet: (id: string) =>
    call<{ change_set: ChangeSetInfo }>(
      `/api/change-sets/${id}/reject`,
      "POST",
    ),
  setFindingStatus: (id: string, status: "open" | "dismissed") =>
    call<{ finding: ReviewFindingInfo }>(
      `/api/review-findings/${id}/status`,
      "POST",
      { status },
    ),
  /** 公開タブ: 話ごとの公開可否 + リリース履歴。 */
  getReleases: (id: string) =>
    call<WorkReleases>(`/api/works/${id}/releases`),
  /** 話の現時点の本文を凍結して公開する。 */
  publishRelease: (workId: string, episodeId: string) =>
    call<{ release: ReleaseInfo }>(
      `/api/works/${workId}/episodes/${episodeId}/releases`,
      "POST",
    ),
  unlistRelease: (id: string) =>
    call<{ release: ReleaseInfo }>(`/api/releases/${id}/unlist`, "POST"),
  /** 失敗/中止した対話ジョブを元メッセージと同じ内容で新規ジョブとして再送。 */
  resendJob: (workId: string, jobId: string) =>
    call<{ message: ChatMessageInfo; job: JobInfo }>(
      `/api/works/${workId}/jobs/${jobId}/resend`,
      "POST",
    ),
  /** ジョブ詳細: 実行ステップ記録 (spec §7.4) 付き。 */
  getJobDetail: (workId: string, jobId: string) =>
    call<{ job: JobInfo; steps: AgentStepInfo[] }>(
      `/api/works/${workId}/jobs/${jobId}`,
    ),
  /** 自律運転の開始/停止 (spec §7.2。開始時は上限往復数を送る)。 */
  setAutonomy: (workId: string, action: "start" | "stop", maxTurns = 10) =>
    call<{ work: WorkInfo }>(`/api/works/${workId}/autonomy`, "POST",
      action === "start" ? { action, max_turns: maxTurns } : { action }),
};
