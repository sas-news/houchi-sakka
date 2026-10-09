import { createContext } from "react-router";
import type { WebDeps } from "../../src/app.js";
import type { Env } from "../../src/env.js";

/**
 * サーバー側 DI コンテナ (workers/app.ts でリクエストごとに構築)。
 * loader は context.get(depsContext) で API と同じ deps を使う。
 */
export const depsContext = createContext<WebDeps>();

export const cloudflareContext = createContext<{
  env: Env;
  ctx: ExecutionContext;
}>();
