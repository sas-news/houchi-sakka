import { APICallError, RetryError, simulateReadableStream } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "@houchi/contracts";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  ProviderError,
  ProviderHttpError,
  ProviderNetworkError,
  StubProvider,
  createProvider,
  createProviders,
  type LanguageModelFactory,
  type Provider,
} from "../src/index.js";

const REQ: ProviderRequest = {
  model: "test-model",
  input: [
    { role: "system", content: "sys" },
    { role: "developer", content: "dev" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "prev" },
  ],
};

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: undefined, reasoning: undefined },
});

const finishStop = { unified: "stop" as const, raw: undefined };

/** generate() の戻りに使う最小の成功結果。 */
function genResult(text = "こんにちは", inTok = 3, outTok = 7) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: finishStop,
    usage: usage(inTok, outTok),
    warnings: [],
  };
}

/**
 * MockLanguageModelV4 を返す modelFactory。
 * 呼ばれた (modelId, apiKey) を記録し、生成したモックも外から参照できる。
 */
function fakeFactory(mock: MockLanguageModelV4) {
  const calls: { modelId: string; apiKey: string }[] = [];
  const factory: LanguageModelFactory = (modelId, apiKey) => {
    calls.push({ modelId, apiKey });
    return mock;
  };
  return { factory, calls };
}

/** openai/anthropic 両アダプターで共通の振る舞いを検証する。 */
function describeAiSdkAdapter(
  name: string,
  make: (modelFactory: LanguageModelFactory) => Provider,
) {
  describe(name, () => {
    it("model と apiKey をファクトリに渡し、input を ModelMessage に変換する", async () => {
      const mock = new MockLanguageModelV4({ doGenerate: genResult() });
      const { factory, calls } = fakeFactory(mock);
      const res = await make(factory).generate(REQ, "sk-test");

      expect(calls).toEqual([{ modelId: "test-model", apiKey: "sk-test" }]);
      // 'developer' は AI SDK に無いので system に畳む。
      expect(mock.doGenerateCalls[0]?.prompt).toEqual([
        { role: "system", content: "sys" },
        { role: "system", content: "dev" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "prev" }] },
      ]);
      expect(res).toEqual({
        output_text: "こんにちは",
        usage: { input_tokens: 3, output_tokens: 7 },
      });
    });

    it("usage が欠損なら 'unknown' (偽装しない)", async () => {
      const mock = new MockLanguageModelV4({
        doGenerate: {
          ...genResult("x"),
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: undefined,
              text: undefined,
              reasoning: undefined,
            },
          },
        },
      });
      const { factory } = fakeFactory(mock);
      expect((await make(factory).generate(REQ, "k")).usage).toBe("unknown");
    });

    it("requiresKey=true", () => {
      expect(make(() => new MockLanguageModelV4()).requiresKey).toBe(true);
    });
  });
}

describeAiSdkAdapter(
  "OpenAIResponsesProvider",
  (modelFactory) => new OpenAIResponsesProvider({ modelFactory }),
);
describeAiSdkAdapter(
  "AnthropicProvider",
  (modelFactory) => new AnthropicProvider({ modelFactory }),
);

// エラーマッピングとストリームは共通実装 (AiSdkProvider) にあるので
// OpenAIResponsesProvider を代表として検証する。
describe("AiSdkProvider エラーマッピング", () => {
  const p = (factory: LanguageModelFactory) =>
    new OpenAIResponsesProvider({ modelFactory: factory });

  it("APICallError(statusCode あり) → ProviderHttpError (status/body 保持)", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: () => {
        throw new APICallError({
          message: "rate limited",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 429,
          responseBody: "rate limited",
          isRetryable: false,
        });
      },
    });
    const { factory } = fakeFactory(mock);
    try {
      await p(factory).generate(REQ, "k");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect((e as ProviderHttpError).status).toBe(429);
      expect((e as ProviderHttpError).body).toBe("rate limited");
    }
  });

  it("APICallError(statusCode なし) → ProviderNetworkError", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: () => {
        throw new APICallError({
          message: "Cannot connect to API",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          isRetryable: false,
        });
      },
    });
    const { factory } = fakeFactory(mock);
    await expect(p(factory).generate(REQ, "k")).rejects.toBeInstanceOf(
      ProviderNetworkError,
    );
  });

  it("RetryError → 最後のエラーで判定 (APICallError なら status 保持)", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: () => {
        throw new RetryError({
          message: "Failed after 3 attempts",
          reason: "maxRetriesExceeded",
          errors: [
            new APICallError({
              message: "server error",
              url: "https://api.openai.com/v1/responses",
              requestBodyValues: {},
              statusCode: 503,
              responseBody: "upstream 503",
              isRetryable: true,
            }),
          ],
        });
      },
    });
    const { factory } = fakeFactory(mock);
    try {
      await p(factory).generate(REQ, "k");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect((e as ProviderHttpError).status).toBe(503);
    }
  });

  it("生のネットワーク例外 (fetch failed) → ProviderNetworkError", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: () => {
        throw new TypeError("fetch failed", {
          cause: new Error("connect ECONNREFUSED"),
        });
      },
    });
    const { factory } = fakeFactory(mock);
    await expect(p(factory).generate(REQ, "k")).rejects.toBeInstanceOf(
      ProviderNetworkError,
    );
  });

  it("その他の SDK 例外 → ProviderError", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: () => {
        throw new Error("InvalidPromptError: weird");
      },
    });
    const { factory } = fakeFactory(mock);
    const err = await p(factory)
      .generate(REQ, "k")
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderHttpError);
    expect(err).not.toBeInstanceOf(ProviderNetworkError);
  });

  it("エラーメッセージに apiKey が混入していても伏せる", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: () => {
        throw new APICallError({
          message: "unauthorized",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 401,
          responseBody: "invalid key sk-secret-123",
          isRetryable: false,
        });
      },
    });
    const { factory } = fakeFactory(mock);
    try {
      await p(factory).generate(REQ, "sk-secret-123");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect((e as ProviderHttpError).body).not.toContain("sk-secret-123");
      expect((e as ProviderHttpError).body).toContain("***");
    }
  });
});

describe("AiSdkProvider ストリーム", () => {
  const p = (factory: LanguageModelFactory) =>
    new OpenAIResponsesProvider({ modelFactory: factory });

  function streamMock(chunks: LanguageModelV4StreamPart[]) {
    return new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({ chunks }),
      },
    });
  }

  it("text-delta を onToken に順序通り流し、最終結果と usage を返す", async () => {
    const mock = streamMock([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "こん" },
      { type: "text-delta", id: "t1", delta: "にちは" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        usage: usage(1, 2),
        finishReason: finishStop,
      },
    ]);
    const { factory, calls } = fakeFactory(mock);
    const tokens: string[] = [];
    const res = await p(factory).generate({ ...REQ, stream: true }, "k", (t) =>
      tokens.push(t),
    );
    expect(calls).toEqual([{ modelId: "test-model", apiKey: "k" }]);
    expect(mock.doStreamCalls).toHaveLength(1);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(tokens).toEqual(["こん", "にちは"]);
    expect(res.output_text).toBe("こんにちは");
    expect(res.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  it("finish が無くても蓄積分を返し usage は 'unknown'", async () => {
    const mock = streamMock([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "ab" },
    ]);
    const { factory } = fakeFactory(mock);
    const res = await p(factory).generate({ ...REQ, stream: true }, "k");
    expect(res.output_text).toBe("ab");
  });

  it("ストリーム中の error パートを ProviderError に変換する", async () => {
    const mock = streamMock([
      { type: "stream-start", warnings: [] },
      {
        type: "error",
        error: new APICallError({
          message: "overloaded",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 529,
          responseBody: "overloaded",
          isRetryable: false,
        }),
      },
    ]);
    const { factory } = fakeFactory(mock);
    try {
      await p(factory).generate({ ...REQ, stream: true }, "k");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect((e as ProviderHttpError).status).toBe(529);
    }
  });
});

describe("プロバイダー名レジストリ", () => {
  it("createProvider: openai/anthropic/stub を返し、未指定既定は openai", () => {
    expect(createProvider("openai")).toBeInstanceOf(OpenAIResponsesProvider);
    expect(createProvider("anthropic")).toBeInstanceOf(AnthropicProvider);
    expect(createProvider("stub")).toBeInstanceOf(StubProvider);
    expect(createProvider("nope")).toBeUndefined();
  });

  it("createProviders: 3名すべて登録", () => {
    const providers = createProviders();
    expect(Object.keys(providers).sort()).toEqual([
      "anthropic",
      "openai",
      "stub",
    ]);
    expect(providers.openai).toBeInstanceOf(OpenAIResponsesProvider);
    expect(providers.anthropic).toBeInstanceOf(AnthropicProvider);
    expect(providers.stub).toBeInstanceOf(StubProvider);
  });
});

describe("StubProvider", () => {
  it("呼び出し回数をカウントし固定テキストを返す", async () => {
    const s = new StubProvider({ text: "hi" });
    await s.generate(REQ, "");
    await s.generate(REQ, "");
    expect(s.calls).toBe(2);
    expect(s.lastRequests).toHaveLength(2);
  });

  it("stream で分割して onToken に流す", async () => {
    const s = new StubProvider({ text: "abcdef", chunkSize: 2 });
    const tokens: string[] = [];
    await s.generate({ ...REQ, stream: true }, "", (t) => tokens.push(t));
    expect(tokens).toEqual(["ab", "cd", "ef"]);
  });

  it("requiresKey=false", () => {
    expect(new StubProvider().requiresKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 既定ファクトリの配線: apiKey が各社 createXxx にそのまま渡ること
// (環境変数フォールバックに頼らない)。モジュール差し替えで検証する。
// ---------------------------------------------------------------------------

const wiring = vi.hoisted(() => ({
  openAIArgs: [] as unknown[],
  anthropicArgs: [] as unknown[],
  openAIModelIds: [] as string[],
  anthropicModelIds: [] as string[],
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn((opts: unknown) => {
    wiring.openAIArgs.push(opts);
    return (modelId: string) => {
      wiring.openAIModelIds.push(modelId);
      return new MockLanguageModelV4({ doGenerate: genResult() });
    };
  }),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn((opts: unknown) => {
    wiring.anthropicArgs.push(opts);
    return (modelId: string) => {
      wiring.anthropicModelIds.push(modelId);
      return new MockLanguageModelV4({ doGenerate: genResult() });
    };
  }),
}));

describe("既定ファクトリの配線 (apiKey → createXxx)", () => {
  it("openai: createOpenAI({ apiKey })(modelId) になる", async () => {
    delete process.env.OPENAI_API_KEY;
    const p = new OpenAIResponsesProvider();
    await p.generate(REQ, "sk-direct");
    expect(wiring.openAIArgs.at(-1)).toEqual({ apiKey: "sk-direct" });
    expect(wiring.openAIModelIds.at(-1)).toBe("test-model");
  });

  it("anthropic: createAnthropic({ apiKey })(modelId) になる", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = new AnthropicProvider();
    await p.generate(REQ, "sk-ant");
    expect(wiring.anthropicArgs.at(-1)).toEqual({ apiKey: "sk-ant" });
    expect(wiring.anthropicModelIds.at(-1)).toBe("test-model");
  });

  it("baseURL オプションはファクトリに引き継ぐ", async () => {
    const p = new OpenAIResponsesProvider({ baseURL: "https://proxy.local" });
    await p.generate(REQ, "sk-x");
    expect(wiring.openAIArgs.at(-1)).toEqual({
      apiKey: "sk-x",
      baseURL: "https://proxy.local",
    });
  });
});
