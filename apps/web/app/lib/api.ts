import type {
  JobInfo,
  KeyInfo,
  ProposalInfo,
  SceneRevisionInfo,
  WorkDetail,
  WorkInfo,
  WorkProse,
  WorkspaceFileInfo,
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
};
