import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authSchema } from "@houchi/database";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/** D1 (本番) と better-sqlite3 (テスト) の両方を受ける。 */
export type AuthDatabase = DrizzleD1Database | BetterSQLite3Database;

/**
 * better-auth (OAuth ログイン) の生成 (spec §9: サイトログインは
 * Google + GitHub の OAuth、パスワード管理は持たない)。
 *
 * emailAndPassword は dev-login 専用に流用する:
 * DEV_LOGIN_ENABLED=true の時だけ有効化し、POST /api/dev/login から
 * 内部的に呼ぶ。本番では無効なのでエンドポイント自体が存在しない。
 */
export interface AuthConfig {
  /** リクエストのオリジン (OAuth のコールバック URL 決定に使う)。 */
  baseUrl: string;
  /** better-auth の署名シークレット (APP_SECRET_KEY を共用)。 */
  secret: string;
  /** dev-login を有効にするか (ローカル開発のみ)。 */
  devLoginEnabled: boolean;
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
}

export function createAuth(db: AuthDatabase, config: AuthConfig) {
  const social: Record<
    string,
    { clientId: string; clientSecret: string }
  > = {};
  if (config.google) {
    social.google = {
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
    };
  }
  if (config.github) {
    social.github = {
      clientId: config.github.clientId,
      clientSecret: config.github.clientSecret,
    };
  }
  return betterAuth({
    database: drizzleAdapter(db as DrizzleD1Database, {
      provider: "sqlite",
      schema: authSchema,
    }),
    secret: config.secret,
    baseURL: config.baseUrl,
    emailAndPassword: { enabled: config.devLoginEnabled },
    ...(Object.keys(social).length > 0 ? { social } : {}),
  });
}

export type Auth = ReturnType<typeof createAuth>;
