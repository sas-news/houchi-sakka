import { drizzle } from "drizzle-orm/d1";
import {
  RouterContextProvider,
  createRequestHandler,
  type ServerBuild,
} from "react-router";
import { cloudflareContext, depsContext } from "../app/lib/context.js";
import { createApp, type WebDeps } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import type { Env } from "../src/env.js";

const requestHandler = createRequestHandler(
  () =>
    import(
      "virtual:react-router/server-build"
    ) as unknown as Promise<ServerBuild>,
  import.meta.env.MODE,
);

/** リクエストごとに DI コンテナを組み立てる (Workers はリクエスト単位)。 */
function makeDeps(request: Request, env: Env): WebDeps {
  const db = drizzle(env.DB);
  const baseUrl = new URL(request.url).origin;
  return {
    db,
    secretKey: env.APP_SECRET_KEY,
    executorToken: env.EXECUTOR_TOKEN,
    auth: createAuth(db, {
      baseUrl,
      secret: env.APP_SECRET_KEY,
      devLoginEnabled: env.DEV_LOGIN_ENABLED === "true",
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
    }),
    devLoginEnabled: env.DEV_LOGIN_ENABLED === "true",
    defaultModel: env.DEFAULT_MODEL ?? "gpt-4o-mini",
    baseUrl,
  };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const deps = makeDeps(request, env);
    const { pathname } = new URL(request.url);
    // API は素の fetch ハンドラ (src/app.ts)、残りは React Router。
    if (pathname.startsWith("/api/")) {
      return createApp(deps)(request);
    }
    const rrContext = new RouterContextProvider();
    rrContext.set(depsContext, deps);
    rrContext.set(cloudflareContext, { env, ctx });
    return requestHandler(request, rrContext);
  },
};
