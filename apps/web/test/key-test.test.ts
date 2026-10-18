import { describe, expect, it } from "vitest";
import http from "node:http";
import { makeApp, makeCall, devLogin } from "./helpers.js";

/** ローカルの OpenAI 互換モック鯖を立てて /chat/completions を処理する。 */
async function startMock(
  handler: (body: string) => [number, unknown],
): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const [code, body] = handler(raw);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const CHAT_OK = {
  id: "chatcmpl-x",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

describe("POST /api/keys/:id/test — キー疎通テスト", () => {
  it("custom キーが 200 を返せば ok=true で応答抜粋が見える", async () => {
    const mock = await startMock(() => [200, CHAT_OK]);
    const { app } = makeApp();
    const call = makeCall(app);
    const cookie = await devLogin(call);
    const created = await call(
      "POST",
      "/api/keys",
      { label: "t", provider: "custom", api_key: "sk-test", base_url: mock.url },
      { cookie },
    );
    const { key } = (await created.json()) as { key: { id: string } };
    const res = await call(
      "POST",
      `/api/keys/${key.id}/test`,
      { model: "m" },
      { cookie },
    );
    const b = (await res.json()) as {
      ok: boolean;
      response?: string;
      error?: string;
    };
    expect(b.ok).toBe(true);
    expect(b.response).toContain("ok");
    await mock.close();
  });

  it("上流が 401 を返せば ok=false でエラー本文が見える", async () => {
    const mock = await startMock(() => [
      401,
      { error: { message: "Invalid API key" } },
    ]);
    const { app } = makeApp();
    const call = makeCall(app);
    const cookie = await devLogin(call);
    const created = await call(
      "POST",
      "/api/keys",
      { label: "t", provider: "custom", api_key: "sk-bad", base_url: mock.url },
      { cookie },
    );
    const { key } = (await created.json()) as { key: { id: string } };
    const res = await call(
      "POST",
      `/api/keys/${key.id}/test`,
      {},
      { cookie },
    );
    const b = (await res.json()) as { ok: boolean; error?: string };
    expect(b.ok).toBe(false);
    expect(b.error).toContain("401");
    expect(b.error).toContain("Invalid API key");
    await mock.close();
  });

  it("他人のキーは 404", async () => {
    const mock = await startMock(() => [200, CHAT_OK]);
    const { app } = makeApp();
    const call = makeCall(app);
    const cookie1 = await devLogin(call);
    const created = await call(
      "POST",
      "/api/keys",
      { label: "t", provider: "custom", api_key: "sk-test", base_url: mock.url },
      { cookie: cookie1 },
    );
    const { key } = (await created.json()) as { key: { id: string } };
    // 別ユーザー
    const res = await call("POST", "/api/auth/sign-up/email", {
      email: "other@example.com",
      password: "test-password-123",
      name: "other",
    }, { token: null });
    const cookie2 = res.headers.get("set-cookie")!.split(";")[0]!;
    const test = await call(
      "POST",
      `/api/keys/${key.id}/test`,
      {},
      { cookie: cookie2 },
    );
    expect(test.status).toBe(404);
    await mock.close();
  });
});
