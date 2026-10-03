// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { STARTUP_CASES } from "../../service/src/testing/startup_cases.ts";
import { resetMigrationSql } from "../../service/src/testing/migration_cases.ts";
import { handleD1 } from "../src/d1_handler.ts";

const database = (env as unknown as { TEST_D1: D1Database }).TEST_D1;
const sql = createD1Sql({ fetch: (input, init) => handleD1(new Request(input, init), database) });
describe("async database startup on D1", () => {
  beforeEach(() => resetMigrationSql(sql));
  for (const testCase of STARTUP_CASES) it(testCase.name, () => testCase.run(sql));
});
