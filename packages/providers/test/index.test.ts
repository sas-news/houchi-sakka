import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "@houchi/contracts";
import {
  OpenAIResponsesProvider,
  ProviderHttpError,
  ProviderNetworkError,
  StubProvider,
} from "../src/index.js";

const REQ: ProviderRequest = {
  model: "gpt-5",
  input: [{ role: "user", content: "hi" }],
};

function mockFetch(impl: (url: string, init: RequestInit) => unknown) {
  return impl as unknown as typeof fetch;
}

describe("OpenAIResponsesProvider", () => {
  it("output[] から output_text を抽出し usage を返す", async () => {
    const p = new OpenAIResponsesProvider({
      fetchImpl: mockFetch((_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe("gpt-5");
        expect(body.input[0].content[0]).toEqual({
          type: "input_text",
          text: "hi",
        });
        expect(String(init.headers && (init.headers as Record<string, string>).authorization)).toBe(
          "Bearer k",
        );
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "こんにちは" }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 7 },
          }),
        );
      }),
    });
    const res = await p.generate(REQ, "k");
    expect(res).toEqual({
      output_text: "こんにちは",
      usage: { input_tokens: 3, output_tokens: 7 },
    });
  });

  it("トップレベル output_text ショートカットも読む", async () => {
    const p = new OpenAIResponsesProvider({
      fetchImpl: mockFetch(() =>
        new Response(JSON.stringify({ output_text: "ok" })),
      ),
    });
    const res = await p.generate(REQ, "k");
    expect(res.output_text).toBe("ok");
    expect(res.usage).toBe("unknown");
  });

  it("usage が無い/欠損なら 'unknown' (偽装しない)", async () => {
    const p = new OpenAIResponsesProvider({
      fetchImpl: mockFetch(() =>
        new Response(
          JSON.stringify({ output_text: "x", usage: { input_tokens: 1 } }),
        ),
      ),
    });
    expect((await p.generate(REQ, "k")).usage).toBe("unknown");
  });

  it("HTTP エラーは status 付きの ProviderHttpError", async () => {
    const p = new OpenAIResponsesProvider({
      fetchImpl: mockFetch(
        () => new Response("rate limited", { status: 429 }),
      ),
    });
    try {
      await p.generate(REQ, "k");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect((e as ProviderHttpError).status).toBe(429);
    }
  });

  it("ネットワーク失敗は ProviderNetworkError", async () => {
    const p = new OpenAIResponsesProvider({
      fetchImpl: mockFetch(() => {
        throw new Error("socket hangup");
      }),
    });
    await expect(p.generate(REQ, "k")).rejects.toBeInstanceOf(
      ProviderNetworkError,
    );
  });

  it("stream: delta を onToken に流し最終応答の usage を返す", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "こん" })}\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "にちは" })}\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 2 } },
      })}\n`,
      "data: [DONE]\n",
    ].join("\n");
    const p = new OpenAIResponsesProvider({
      fetchImpl: mockFetch((_url, init) => {
        expect(JSON.parse(String(init.body)).stream).toBe(true);
        return new Response(sse);
      }),
    });
    const tokens: string[] = [];
    const res = await p.generate({ ...REQ, stream: true }, "k", (t) =>
      tokens.push(t),
    );
    expect(tokens).toEqual(["こん", "にちは"]);
    expect(res.output_text).toBe("こんにちは");
    expect(res.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  it("stream: response.completed が無くても蓄積分を返す", async () => {
    const sse = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ab" })}\n`;
    const p = new OpenAIResponsesProvider({
      fetchImpl: mockFetch(() => new Response(sse)),
    });
    const res = await p.generate({ ...REQ, stream: true }, "k");
    expect(res.output_text).toBe("ab");
    expect(res.usage).toBe("unknown");
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
