// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
/** The portable backup fixture is compared byte-for-byte to workerd's output by its scenario test. */
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
  expect(result.tables.glossary_terms).toBe(1);
  expect(result.tables.comments).toBe(1);
  expect(result.tables.language_requests).toBe(1);
  expect(result.tables.language_request_votes).toBe(1);
  expect((await t.service.exportFiles(SYSTEM, {})).files).toStrictEqual(portable.export.files);
  expect((await t.service.listGlossary(ANONYMOUS, {})).terms[0].term).toBe("Wayfarer");
  expect(
    (await t.service.listLanguageRequests(ANONYMOUS, {})).requests.map((r) => [r.tag, r.votes]),
  ).toStrictEqual([["eo", 1]]);
});
