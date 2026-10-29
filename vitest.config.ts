// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

/**
 * `npm test` runs the unit project; `npm run e2e` and `npm run acceptance` run the others.
 * The Cloudflare package has its own config, for the Workers pool.
 */
export default defineConfig({
  test: {
    // Many tests start servers and processes; a slow CI machine shouldn't fail them.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/{core,service,server,cli,design-system}/**/*.test.{ts,tsx}",
            "packages/web/src/**/*.test.{ts,tsx}",
            "scripts/**/*.test.ts",
            "site/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      { extends: true, test: { name: "e2e", include: ["e2e/**/*.test.ts"] } },
      { extends: true, test: { name: "acceptance", include: ["acceptance/**/*.test.ts"] } },
    ],
  },
});
