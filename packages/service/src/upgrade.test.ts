// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assert, assertEquals } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { SYSTEM } from "./api.ts";
import { drain } from "./jobs/testing.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import { DATABASE_VERSION } from "./migrations.ts";
import { createService } from "./service.ts";
import { FakeScheduler, TestClock, uploadJson } from "./test_helpers.ts";

const fixtures = fromFileUrl(new URL("../testdata/upgrade/", import.meta.url));

for (const version of [1, 3]) {
  test(`upgrade historical schema ${version}: preserve rows and export bytes, then continue working`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "quaso-upgrade-" });
    try {
      const file = join(dir, "quaso.sqlite");
      await fs.copyFile(join(fixtures, `v${version}.sqlite`), file);
      const database = openNodeSqlite(file);
      try {
        const before = Object.fromEntries(
          database.sql
            .query<{
              name: string;
            }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .map(({ name }) => [name, database.sql.query(`SELECT * FROM "${name}"`)]),
        );
        const clock = new TestClock();
        const migrations: number[][] = [];
        const service = createService({
          sql: database.sql,
          scheduler: new FakeScheduler(),
          clock: clock.clock,
          secretKey: "upgrade-test-secret",
          provider: createFakeTranslator(),
          beforeMigrate(from, to) {
            migrations.push([from, to]);
            assertEquals(
              database.sql.query("SELECT value FROM meta WHERE key = 'schema_version'"),
              [{ value: String(version) }],
            );
          },
        });
        const started = await service.start();
        assertEquals(started.schemaVersion, { from: version, to: DATABASE_VERSION });
        assertEquals(migrations, [[version, DATABASE_VERSION]]);
        for (const [table, rows] of Object.entries(before)) {
          const current = database.sql.query(`SELECT * FROM "${table}"`);
          if (table === "meta") continue;
          assertEquals(current.length, rows.length, `${table}: every row survives`);
          for (let i = 0; i < rows.length; i++) {
            for (const [column, value] of Object.entries(rows[i])) {
              assertEquals(current[i][column], value, `${table}[${i}].${column}`);
            }
          }
        }
        for (const table of ["history", "uploads", "activity", "translations"]) {
          assert(before[table].length > 0, `${table}: fixture exercises existing data`);
        }
        const expectedExport = JSON.parse(
          await fs.readFile(join(fixtures, `v${version}-export.json`), "utf8"),
        );
        const expectedStatus = JSON.parse(
          await fs.readFile(join(fixtures, `v${version}-status.json`), "utf8"),
        );
        assertEquals((await service.exportFiles(SYSTEM, {})).files, expectedExport.files);
        assertEquals((await service.getStatus(SYSTEM, {})).languages, expectedStatus.languages);
        const upload = await uploadJson(
          service,
          {
            "after-upgrade.json": { hello: "Hello after upgrade" },
          },
          {
            partial: true,
          },
        );
        assert(upload.job);
        await drain({ service, sql: database.sql, clock });
        assertEquals((await service.getJob(SYSTEM, { id: upload.job.id })).status, "done");
        const result = await service.listStrings(SYSTEM, {
          language: "de",
          q: "Hello after upgrade",
        });
        assertEquals(result.strings.length, 1);
        assertEquals(result.strings[0].translation?.colour, "green");
        await service.importTranslations(SYSTEM, {
          language: "de",
          as: "blue",
          files: [{ path: "after-upgrade.json", content: '{"hello":"Hallo nach dem Upgrade"}\n' }],
        });
        assert(
          (await service.exportFiles(SYSTEM, { languages: ["de"] })).files.some((f) =>
            f.content.includes("Hallo nach dem Upgrade"),
          ),
        );
      } finally {
        database.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
}
