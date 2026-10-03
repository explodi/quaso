// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { geminiStub } from "./test/gemini_stub.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.test.jsonc" },
      // The Worker's outbound fetch: a fake Gemini API, and nothing else (the tests are offline).
      miniflare: { outboundService: geminiStub as never },
    }),
  ],
  resolve: {
    alias: [
      { find: /^@quaso\/core$/, replacement: here("../core/mod.ts") },
      { find: /^@quaso\/service$/, replacement: here("../service/mod.ts") },
      {
        find: /^@quaso\/service\/sql-cases$/,
        replacement: here("../service/src/testing/sql_cases.ts"),
      },
    ],
  },
  // Logs of passing tests (the service's JSON lines) are noise.
  test: { include: ["test/**/*.test.ts"], silent: "passed-only" },
});
