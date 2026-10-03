// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { resetUploadSql, UPLOAD_CASES } from "../../service/src/testing/upload_cases.ts";
import { handleD1 } from "../src/d1_handler.ts";

const database = (env as unknown as { TEST_D1: D1Database }).TEST_D1;
const sql = createD1Sql({ fetch: (input, init) => handleD1(new Request(input, init), database) });

describe("upload over the private D1 handler", () => {
  beforeEach(() => resetUploadSql(sql));
  for (const testCase of UPLOAD_CASES) it(testCase.name, () => testCase.run(sql));
});
