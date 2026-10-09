import { defineConfig } from "drizzle-kit";

// drizzle-kit はスキーマから migration SQL を生成する役割。
// 生成物は migrations/ に置き、wrangler d1 migrations apply と
// ローカル/テストの better-sqlite3 の両方で同じ SQL を適用する。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
