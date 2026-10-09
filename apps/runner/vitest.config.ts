import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@houchi\/contracts$/, replacement: r("../../packages/contracts/src/index.ts") },
      { find: /^@houchi\/database\/testing$/, replacement: r("../../packages/database/src/testing.ts") },
      { find: /^@houchi\/database$/, replacement: r("../../packages/database/src/index.ts") },
      { find: /^@houchi\/harness$/, replacement: r("../../packages/harness/src/index.ts") },
      { find: /^@houchi\/providers$/, replacement: r("../../packages/providers/src/index.ts") },
      { find: /^@houchi\/secrets$/, replacement: r("../../packages/secrets/src/index.ts") },
      { find: /^@houchi\/web$/, replacement: r("../../apps/web/src/app.ts") },
    ],
  },
});
