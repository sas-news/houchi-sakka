import { createTestDb } from "@houchi/database/testing";
import { createApp, type FetchHandler } from "../src/app.js";
import { createAuth } from "../src/auth.js";

export const SECRET_KEY = btoa("0123456789abcdef0123456789abcdef");
export const TOKEN = "test-executor-token";
export const BASE_URL = "http://localhost";

export function makeApp(opts: { devLogin?: boolean } = {}) {
  const db = createTestDb();
  const devLoginEnabled = opts.devLogin ?? true;
  const auth = createAuth(db, {
    baseUrl: BASE_URL,
    secret: SECRET_KEY,
    devLoginEnabled,
  });
  const app = createApp({
    db,
    secretKey: SECRET_KEY,
    executorToken: TOKEN,
    auth,
    devLoginEnabled,
    defaultModel: "stub-model",
    baseUrl: BASE_URL,
  });
  return { app, db };
}

export interface CallOptions {
  token?: string | null;
  cookie?: string | null;
}

export function makeCall(app: FetchHandler) {
  return (
    method: string,
    path: string,
    body?: unknown,
    opts: CallOptions = {},
  ): Promise<Response> => {
    const { token = TOKEN, cookie = null } = opts;
    return app(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers: {
          ...(body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
}

/** Set-Cookie ヘッダーから Cookie ヘッダー値 (name=value) を取り出す。 */
export function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no set-cookie header");
  return setCookie.split(";")[0]!;
}

/** better-auth の email 登録でユーザーを作り、セッション cookie を返す。 */
export async function signUp(
  call: ReturnType<typeof makeCall>,
  email: string,
  name = "テストユーザー",
): Promise<string> {
  const res = await call(
    "POST",
    "/api/auth/sign-up/email",
    { email, password: "test-password-123", name },
    { token: null },
  );
  if (!res.ok) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  return cookieFrom(res);
}

/** dev-login で開発ユーザーのセッション cookie を返す。 */
export async function devLogin(
  call: ReturnType<typeof makeCall>,
): Promise<string> {
  const res = await call("POST", "/api/dev/login", undefined, {
    token: null,
  });
  if (!res.ok) {
    throw new Error(`dev login failed: ${res.status}`);
  }
  return cookieFrom(res);
}
