/**
 * Workers 環境変数・バインディングの型。
 * .dev.vars / wrangler secret から供給される値はここに書く。
 */
export interface Env {
  DB: D1Database;
  /** AES-256-GCM 鍵 (base64 32B)。better-auth の secret としても共用。 */
  APP_SECRET_KEY: string;
  /** 実行体(Runner)と共有する Bearer トークン。 */
  EXECUTOR_TOKEN: string;
  /** "true" の時だけ開発用ワンクリックログインを有効化。本番では絶対に付けない。 */
  DEV_LOGIN_ENABLED?: string;
  /** OAuth アプリの認証情報 (未設定ならそのプロバイダーのログインは出ない)。 */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** orchestrator_turn の既定モデル。 */
  DEFAULT_MODEL?: string;
}
