// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { createD1Sql, createR2Store } from "@quaso/service";
import { NIGHTLY_BACKUP_CASES } from "../../service/src/testing/nightly_backup_cases.ts";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { handleD1 } from "../src/d1_handler.ts";
import { handleR2 } from "../src/r2_handler.ts";
const bindings = env as unknown as { TEST_D1: D1Database; BACKUPS: R2Bucket };
const sql = createD1Sql({
  fetch: (input, init) => handleD1(new Request(input, init), bindings.TEST_D1),
});
const store = createR2Store({
  fetch: (input, init) => handleR2(new Request(input, init), bindings.BACKUPS),
});
describe("nightly backups through the private D1 and R2 handlers", () => {
  beforeEach(async () => {
    await resetUploadSql(sql);
    const keys = [];
    for await (const object of store.list("")) keys.push(object.key);
    await store.delete(keys);
  });
  for (const testCase of NIGHTLY_BACKUP_CASES) it(testCase.name, () => testCase.run(sql, store));
});
