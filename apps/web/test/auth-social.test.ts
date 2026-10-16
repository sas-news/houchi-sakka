import { describe, expect, it } from "vitest";
import { makeApp, makeCall } from "./helpers.js";

describe("OAuth social ログイン", () => {
  it("github 設定ありなら sign-in/social がプロバイダーの認証 URL を返す", async () => {
    const { app } = makeApp({
      github: { clientId: "cid", clientSecret: "csec" },
    });
    const call = makeCall(app);
    const res = await call(
      "POST",
      "/api/auth/sign-in/social",
      { provider: "github", callbackURL: "/" },
      { token: null },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toContain("github.com/login/oauth/authorize");
    expect(body.url).toContain("client_id=cid");
  });

  it("github 未設定なら PROVIDER_NOT_FOUND", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const res = await call(
      "POST",
      "/api/auth/sign-in/social",
      { provider: "github", callbackURL: "/" },
      { token: null },
    );
    expect(res.status).toBe(404);
  });
});
