import { defineConfig } from "vitest/config";

const r = (p: string) => new URL(p, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [
      // workspace のソースを直接解決する (dist ビルドなしでテストできる)。
      { find: /^@houchi\/contracts$/, replacement: r("../../packages/contracts/src/index.ts") },
      { find: /^@houchi\/database\/testing$/, replacement: r("../../packages/database/src/testing.ts") },
      { find: /^@houchi\/database$/, replacement: r("../../packages/database/src/index.ts") },
      { find: /^@houchi\/secrets$/, replacement: r("../../packages/secrets/src/index.ts") },
    ],
  },
});
