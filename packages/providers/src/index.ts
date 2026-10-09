import type {
  ProviderInputMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
} from "@houchi/contracts";

/**
 * packages/providers — プロバイダー非依存の Provider インターフェースと
 * OpenAI Responses API アダプター / テスト用 Stub (spec §8.1, Phase 0)。
 */

export class ProviderError extends Error {
  override name = "ProviderError";
}

/** HTTP エラー。status を型付きで保持する。 */
export class ProviderHttpError extends ProviderError {
  override name = "ProviderHttpError";
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`provider returned HTTP ${status}`);
  }
}

/** ネットワーク障害・タイムアウト等 (HTTP に届かない)。 */
export class ProviderNetworkError extends ProviderError {
  override name = "ProviderNetworkError";
}

export type TokenCallback = (text: string) => void;

export interface Provider {
  /** apiKey が不要なプロバイダー (stub) は false。 */
  readonly requiresKey: boolean;
  generate(
    req: ProviderRequest,
    apiKey: string,
    onToken?: TokenCallback,
  ): Promise<ProviderResponse>;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ResponsesContentPart {
  type?: string;
  text?: string;
}

interface ResponsesOutputItem {
  type?: string;
  content?: ResponsesContentPart[];
}

interface ResponsesBody {
  output_text?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
}

function extractUsage(u: ResponsesUsage | undefined): ProviderUsage {
  if (
    u &&
    typeof u.input_tokens === "number" &&
    typeof u.output_tokens === "number"
  ) {
    return { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
  }
  return "unknown";
}

function extractText(body: ResponsesBody): string {
  if (typeof body.output_text === "string") return body.output_text;
  const parts: string[] = [];
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

function toResponsesInput(input: ProviderInputMessage[]) {
  return input.map((m) => ({
    type: "message",
    role: m.role,
    content: [{ type: "input_text", text: m.content }],
  }));
}

export class OpenAIResponsesProvider implements Provider {
  readonly requiresKey = true;

  constructor(
    private readonly opts: {
      baseUrl?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  private endpoint(): string {
    return `${this.opts.baseUrl ?? DEFAULT_BASE_URL}/responses`;
  }

  async generate(
    req: ProviderRequest,
    apiKey: string,
    onToken?: TokenCallback,
  ): Promise<ProviderResponse> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(this.endpoint(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          input: toResponsesInput(req.input),
          ...(req.stream ? { stream: true } : {}),
        }),
      });
    } catch (e) {
      throw new ProviderNetworkError(
        `request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 1000);
      throw new ProviderHttpError(res.status, body);
    }
    if (req.stream) {
      return this.readStream(res, onToken);
    }
    const body = (await res.json()) as ResponsesBody;
    return { output_text: extractText(body), usage: extractUsage(body.usage) };
  }

  /** SSE を読み、delta を onToken へ流し、最終 response.completed を解釈する。 */
  private async readStream(
    res: Response,
    onToken: TokenCallback | undefined,
  ): Promise<ProviderResponse> {
    if (!res.body) throw new ProviderNetworkError("empty stream body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accumulated = "";
    let finalBody: ResponsesBody | undefined;

    const handleEvent = (data: string) => {
      if (data === "[DONE]") return;
      let evt: {
        type?: string;
        delta?: string;
        response?: ResponsesBody;
        error?: { message?: string };
      };
      try {
        evt = JSON.parse(data) as typeof evt;
      } catch {
        return;
      }
      if (evt.type === "response.output_text.delta" && evt.delta) {
        accumulated += evt.delta;
        onToken?.(evt.delta);
      } else if (evt.type === "response.completed" && evt.response) {
        finalBody = evt.response;
      } else if (
        evt.type === "response.failed" ||
        evt.type === "error"
      ) {
        throw new ProviderHttpError(500, evt.error?.message ?? evt.type);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trimEnd();
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
        }
      }
      const tail = buf.trim();
      if (tail.startsWith("data:")) handleEvent(tail.slice(5).trim());
    } finally {
      reader.releaseLock();
    }

    if (finalBody) {
      return {
        output_text: extractText(finalBody) || accumulated,
        usage: extractUsage(finalBody.usage),
      };
    }
    return { output_text: accumulated, usage: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// StubProvider (テスト・ローカルスモーク用)
// ---------------------------------------------------------------------------

export class StubProvider implements Provider {
  readonly requiresKey = false;

  /** 呼び出し回数。再開時にプロバイダーが再呼出しされないことの検証に使う。 */
  calls = 0;
  readonly lastRequests: ProviderRequest[] = [];

  constructor(
    private readonly stubOpts: {
      /** 固定の出力テキスト。 */
      text?: string;
      /** 返す usage。既定 'unknown' (偽装しない)。 */
      usage?: ProviderUsage;
      /** stream 時のトークン分割文字数。0/未指定で一括。 */
      chunkSize?: number;
      /** 呼び出しを必ず失敗させる。 */
      failWith?: Error;
    } = {},
  ) {}

  async generate(
    req: ProviderRequest,
    _apiKey: string,
    onToken?: TokenCallback,
  ): Promise<ProviderResponse> {
    this.calls += 1;
    this.lastRequests.push(req);
    if (this.stubOpts.failWith) throw this.stubOpts.failWith;
    const text =
      this.stubOpts.text ??
      `[stub ${req.model}] ${req.input.map((m) => m.content).join(" / ")}`;
    if (req.stream && onToken) {
      const n = this.stubOpts.chunkSize ?? 0;
      if (n > 0) {
        for (let i = 0; i < text.length; i += n) onToken(text.slice(i, i + n));
      } else {
        onToken(text);
      }
    }
    return { output_text: text, usage: this.stubOpts.usage ?? "unknown" };
  }
}
