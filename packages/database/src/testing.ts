import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { DbLike } from "./index.js";

/**
 * ローカル開発・テスト用: migrations/*.sql をメモリ上の better-sqlite3 に
 * 順番適用し、drizzle の better-sqlite3 ドライバを返す。
 * wrangler の D1 ローカルと同じ SQL を使うので挙動が一致する。
 */
export function createTestDb(
  migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "migrations",
  ),
): DbLike {
  const sqlite = new BetterSqlite3(":memory:");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), "utf8");
    for (const stmt of body.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) sqlite.exec(s);
    }
  }
  return drizzle(sqlite);
}
