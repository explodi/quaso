// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { createR2Store } from "../../service/src/adapters/r2_store.ts";
import { STORED_BACKUP_CASES } from "../../service/src/testing/stored_backup_cases.ts";
import { handleR2 } from "../src/r2_handler.ts";
const bucket = (env as unknown as { BACKUPS: R2Bucket }).BACKUPS;
const store = createR2Store({ fetch: (input, init) => handleR2(new Request(input, init), bucket) });
describe("stored backups on R2", () => {
  beforeEach(async () => {
    const keys = [];
    for await (const object of store.list("")) keys.push(object.key);
    await store.delete(keys);
  });
  for (const testCase of STORED_BACKUP_CASES) it(testCase.name, () => testCase.run(store));
});
