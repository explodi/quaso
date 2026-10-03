// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { SETTINGS_CASES } from "../../service/src/testing/settings_cases.ts";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { handleD1 } from "../src/d1_handler.ts";

const database = (env as unknown as { TEST_D1: D1Database }).TEST_D1;
const sql = createD1Sql({ fetch: (input, init) => handleD1(new Request(input, init), database) });

describe("async settings on D1", () => {
  beforeEach(() => resetUploadSql(sql));
  for (const testCase of SETTINGS_CASES) it(testCase.name, () => testCase.run(sql));
});
