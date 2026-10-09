import type { WorkDetail } from "./types";

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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
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
};
