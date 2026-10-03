// SPDX-License-Identifier: MIT
import { test } from "node:test";
/** The portable backup fixture is compared byte-for-byte to workerd's output by its scenario test. */
import { assertEquals } from "@quaso/runtime/assert";
import type { BackupDocument, ExportResult } from "@quaso/core";
import fixture from "../../cloudflare/test/fixtures/demo.json" with { type: "json" };
import { ANONYMOUS, SYSTEM } from "./api.ts";
import { documentSource, restoreBackup } from "./backup.ts";
import { startTestService } from "./test_helpers.ts";

test("cross-storage: restore the backup contract shared with workerd into local SQLite", async () => {
  using t = await startTestService();
  // The workerd scenario must produce this exact document, not merely equivalent exports.
  const portable = fixture.output as unknown as {
    backup: BackupDocument;
    export: ExportResult;
  };
  const result = await restoreBackup(t.service, documentSource(portable.backup));
  assertEquals(result.tables.glossary_terms, 1);
  assertEquals(result.tables.comments, 1);
  assertEquals(result.tables.language_requests, 1);
  assertEquals(result.tables.language_request_votes, 1);
  assertEquals((await t.service.exportFiles(SYSTEM, {})).files, portable.export.files);
  assertEquals((await t.service.listGlossary(ANONYMOUS, {})).terms[0].term, "Wayfarer");
  assertEquals(
    (await t.service.listLanguageRequests(ANONYMOUS, {})).requests.map((r) => [r.tag, r.votes]),
    [["eo", 1]],
  );
});
