import { APICallError, RetryError, generateText, streamText } from "ai";
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  ProviderInputMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
} from "@houchi/contracts";

/**
 * packages/providers — プロバイダー非依存の Provider インターフェースと
 * 各社アダプター / テスト用 Stub (spec §8.1)。
 *
 * 内部実装は Vercel AI SDK (`ai`) に委譲し、OpenAI / Anthropic の
 * API 差分はそちらに吸収させる。BYO APIキーは generate() 呼び出し時に
 * 各プロバイダーファクトリへ渡す (環境変数フォールバックには頼らない)。
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
// プロバイダー名 → Provider (runner のレジストリ名に対応)
// ---------------------------------------------------------------------------

/** payload.provider 未指定時の既定。 */
export const DEFAULT_PROVIDER_NAME = "openai";

/**
 * プロバイダー名から Provider を組み立てる。
 * 未知の名前は undefined (呼び出し側でエラー化する)。
 */
export function createProvider(name: string): Provider | undefined {
  switch (name) {
    case "openai":
      return new OpenAIResponsesProvider();
    case "anthropic":
      return new AnthropicProvider();
    case "stub":
      return new StubProvider();
    default:
      return undefined;
  }
}

/** 全プロバイダーのレジストリ (runner がそのまま使える形)。 */
export function createProviders(): Record<string, Provider> {
  return {
    openai: new OpenAIResponsesProvider(),
    anthropic: new AnthropicProvider(),
    stub: new StubProvider(),
  };
}

// ---------------------------------------------------------------------------
// Vercel AI SDK 共通実装
// ---------------------------------------------------------------------------

/**
 * req.model + apiKey から AI SDK の LanguageModel を作るファクトリ。
 * 実運用では各社の createXxx({ apiKey }) を噛ませる。
 * テストでは MockLanguageModelV4 等を返すフェイクを差し込む。
 */
export type LanguageModelFactory = (
  modelId: string,
  apiKey: string,
) => LanguageModel;

/** ProviderInputMessage → AI SDK ModelMessage。 */
function toMessages(input: ProviderInputMessage[]): ModelMessage[] {
  return input.map((m): ModelMessage => {
    switch (m.role) {
      // AI SDK に 'developer' ロールは無い。system に畳む
      // (OpenAI 側では SDK が system→developer に再マップする)。
      case "system":
      case "developer":
        return { role: "system", content: m.content };
      case "assistant":
        return { role: "assistant", content: m.content };
      case "user":
      default:
        return { role: "user", content: m.content };
    }
  });
}

function extractUsage(u: LanguageModelUsage | undefined): ProviderUsage {
  if (
    u &&
    typeof u.inputTokens === "number" &&
    typeof u.outputTokens === "number"
  ) {
    return { input_tokens: u.inputTokens, output_tokens: u.outputTokens };
  }
  return "unknown";
}

/** エラーメッセージに apiKey が紛れ込んだ場合に備えて伏せる。 */
function scrubSecrets(text: string, apiKey: string): string {
  return apiKey === "" ? text : text.split(apiKey).join("***");
}

const NETWORK_ERROR_PATTERN =
  /fetch failed|econnrefused|enotfound|econnreset|econnaborted|etimedout|eai_again|epipe|socket hang ?up|network|timed out|terminated|connection/i;

/** 生の Error (fetch 失敗の TypeError 等) がネットワーク系かを cause チェーンで判定する。 */
function isNetworkError(e: Error): boolean {
  for (let cur: unknown = e; cur instanceof Error; cur = cur.cause) {
    if (NETWORK_ERROR_PATTERN.test(`${cur.name} ${cur.message}`)) return true;
  }
  return false;
}

/** AI SDK / その他の例外を既存の ProviderError 系にマップする。 */
function toProviderError(e: unknown, apiKey: string): ProviderError {
  if (e instanceof ProviderError) return e;

  // リトライ枯渇は最後のエラー (APICallError 等) に置き換えて判定する。
  if (RetryError.isInstance(e)) {
    const last = e.lastError ?? e.errors.at(-1);
    if (last !== undefined) return toProviderError(last, apiKey);
  }
  if (APICallError.isInstance(e)) {
    if (typeof e.statusCode === "number") {
      return new ProviderHttpError(
        e.statusCode,
        scrubSecrets(e.responseBody ?? e.message, apiKey).slice(0, 1000),
      );
    }
    // statusCode が無い = 応答に届いていない (DNS・接続拒否・タイムアウト)。
    return new ProviderNetworkError(scrubSecrets(e.message, apiKey));
  }
  if (e instanceof Error) {
    const message = scrubSecrets(e.message, apiKey);
    return isNetworkError(e)
      ? new ProviderNetworkError(message)
      : new ProviderError(message);
  }
  return new ProviderError(scrubSecrets(String(e), apiKey));
}

export interface AiSdkProviderOptions {
  /** プロバイダーの baseURL を変えたい場合 (プロキシ・モック鯖等)。 */
  baseURL?: string;
  /** テスト差し替え用。未指定時は各社の createXxx({ apiKey })。 */
  modelFactory?: LanguageModelFactory;
}

/**
 * AI SDK ベースの Provider 実装。
 * modelFactory で LanguageModel を解決し、generateText / streamText に投げる。
 */
export class AiSdkProvider implements Provider {
  readonly requiresKey = true;

  constructor(private readonly modelFactory: LanguageModelFactory) {}

  async generate(
    req: ProviderRequest,
    apiKey: string,
    onToken?: TokenCallback,
  ): Promise<ProviderResponse> {
    const model = this.modelFactory(req.model, apiKey);
    const messages = toMessages(req.input);
    if (req.stream === true) {
      return this.generateStream(model, messages, apiKey, onToken);
    }
    try {
      // input はサービス側が組み立てた信頼メッセージ列なので system 混在を許可する。
      const res = await generateText({
        model,
        messages,
        allowSystemInMessages: true,
      });
      return { output_text: res.text, usage: extractUsage(res.usage) };
    } catch (e) {
      throw toProviderError(e, apiKey);
    }
  }

  private async generateStream(
    model: LanguageModel,
    messages: ModelMessage[],
    apiKey: string,
    onToken?: TokenCallback,
  ): Promise<ProviderResponse> {
    try {
      const result = streamText({
        model,
        messages,
        allowSystemInMessages: true,
      });
      let accumulated = "";
      // textStream ではなく fullStream を読み、error パートをここで例外化する
      // (result.text / result.usage はストリーム中のエラーでは reject されない)。
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          accumulated += part.text;
          onToken?.(part.text);
        } else if (part.type === "error") {
          throw part.error;
        }
      }
      const [finalText, usage] = await Promise.all([result.text, result.usage]);
      return {
        output_text: finalText || accumulated,
        usage: extractUsage(usage),
      };
    } catch (e) {
      throw toProviderError(e, apiKey);
    }
  }
}

/** OpenAI (Responses API)。内部は @ai-sdk/openai。 */
export class OpenAIResponsesProvider extends AiSdkProvider {
  constructor(opts: AiSdkProviderOptions = {}) {
    super(
      opts.modelFactory ??
        ((modelId, apiKey) =>
          createOpenAI({
            apiKey,
            ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
          })(modelId)),
    );
  }
}

/** Anthropic (Messages API)。内部は @ai-sdk/anthropic。 */
export class AnthropicProvider extends AiSdkProvider {
  constructor(opts: AiSdkProviderOptions = {}) {
    super(
      opts.modelFactory ??
        ((modelId, apiKey) =>
          createAnthropic({
            apiKey,
            ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
          })(modelId)),
    );
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
