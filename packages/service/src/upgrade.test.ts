// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import { createService } from "./service.ts";
import { FakeScheduler, TestClock } from "./test_helpers.ts";

const fixtures = fromFileUrl(new URL("../testdata/upgrade/", import.meta.url));

async function startBeta1Database(version: number) {
  const dir = await Deno.makeTempDir({ prefix: "quaso-beta-1-" });
  const file = join(dir, "quaso.sqlite");
  await fs.copyFile(join(fixtures, `v${version}.sqlite`), file);
  const database = openNodeSqlite(file);
  const service = createService({
    sql: database.sql,
    scheduler: new FakeScheduler(),
    clock: new TestClock().clock,
    secretKey: "upgrade-test-secret",
    provider: createFakeTranslator(),
  });
  return { dir, file, database, service };
}

test("a Beta 1 database at schema version 1 is refused, and left unchanged", async () => {
  const beta1 = await startBeta1Database(1);
  try {
    const before = await fs.readFile(beta1.file);
    await assertRejects(() => beta1.service.start(), Error, "This database is from Beta 1");
    beta1.database.close();
    assertEquals(await fs.readFile(beta1.file), before);
  } finally {
    await fs.rm(beta1.dir, { recursive: true });
  }
});

test("a Beta 1 database at schema version 3 is refused, and left unchanged", async () => {
  const beta1 = await startBeta1Database(3);
  try {
    const before = await fs.readFile(beta1.file);
    await assertRejects(() => beta1.service.start(), Error, "This database is from Beta 1");
    beta1.database.close();
    assertEquals(await fs.readFile(beta1.file), before);
  } finally {
    await fs.rm(beta1.dir, { recursive: true });
  }
});
