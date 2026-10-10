import type {
  AddCanonFactsRequest,
  AppendMessageRequest,
  AppendMessageResponse,
  CanonFactsResponse,
  CompleteRequest,
  CreateJobRequest,
  CreateJobResponse,
  CreateKeyRequest,
  CreateKeyResponse,
  CreateProposalRequest,
  FailRequest,
  HeartbeatRequest,
  JobResponse,
  LeaseRequest,
  LeaseResponse,
  PersistRevisionRequest,
  ProgressRequest,
  ProgressResponse,
  ProposalResponse,
  ResolveKeyRequest,
  ResolveKeyResponse,
  SceneContextResponse,
  SceneRevisionResponse,
  ThreadContextResponse,
  WorkPatchRequest,
} from "@houchi/contracts";

/** Web API クライアント (実行体認証)。HTTP エラーは status/code 付きで型付ける。 */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly executorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.executorToken}`,
      },
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

  createJob(req: CreateJobRequest): Promise<CreateJobResponse> {
    return this.call("POST", "/api/jobs", req);
  }
  lease(req: LeaseRequest): Promise<LeaseResponse> {
    return this.call("POST", "/api/jobs/lease", req);
  }
  getJob(id: string): Promise<JobResponse> {
    return this.call("GET", `/api/jobs/${id}`);
  }
  progress(id: string, req: ProgressRequest): Promise<ProgressResponse> {
    return this.call("POST", `/api/jobs/${id}/progress`, req);
  }
  heartbeat(id: string, req: HeartbeatRequest): Promise<JobResponse> {
    return this.call("POST", `/api/jobs/${id}/heartbeat`, req);
  }
  complete(id: string, req: CompleteRequest): Promise<JobResponse> {
    return this.call("POST", `/api/jobs/${id}/complete`, req);
  }
  fail(id: string, req: FailRequest): Promise<JobResponse> {
    return this.call("POST", `/api/jobs/${id}/fail`, req);
  }
  resolveKey(ref: string, req: ResolveKeyRequest): Promise<ResolveKeyResponse> {
    return this.call("POST", `/api/internal/keys/${ref}/resolve`, req);
  }
  getThreadContext(id: string): Promise<ThreadContextResponse> {
    return this.call("GET", `/api/internal/threads/${id}/context`);
  }
  appendMessage(
    threadId: string,
    req: AppendMessageRequest,
  ): Promise<AppendMessageResponse> {
    return this.call(
      "POST",
      `/api/internal/threads/${threadId}/messages`,
      req,
    );
  }
  patchWork(id: string, req: WorkPatchRequest): Promise<unknown> {
    return this.call("POST", `/api/internal/works/${id}/patch`, req);
  }
  createProposal(req: CreateProposalRequest): Promise<ProposalResponse> {
    return this.call("POST", "/api/internal/proposals", req);
  }
  addCanonFacts(
    workId: string,
    req: AddCanonFactsRequest,
  ): Promise<CanonFactsResponse> {
    return this.call("POST", `/api/internal/works/${workId}/canon-facts`, req);
  }
  getSceneContext(id: string): Promise<SceneContextResponse> {
    return this.call("GET", `/api/internal/scenes/${id}/context`);
  }
  persistSceneRevision(
    sceneId: string,
    req: PersistRevisionRequest,
  ): Promise<SceneRevisionResponse> {
    return this.call(
      "POST",
      `/api/internal/scenes/${sceneId}/revisions`,
      req,
    );
  }
  createKey(req: CreateKeyRequest): Promise<CreateKeyResponse> {
    return this.call("POST", "/api/internal/keys", req);
  }
}
