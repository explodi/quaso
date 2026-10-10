// SPDX-License-Identifier: MIT
/** A local SQLite backup restores through the D1 service without losing community data. */
import { beforeEach, expect, it } from "vitest";
import {
  ANONYMOUS,
  createAsyncService,
  documentSource,
  restoreBackup,
  SYSTEM,
} from "@quaso/service";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { sql } from "./env.ts";
import fixture from "./fixtures/demo.json";

beforeEach(() => resetUploadSql(sql));
it("restores the local fixture on D1 with identical exports and composite vote keys", async () => {
  const service = createAsyncService({
    sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "backup-test",
  });
  await service.start();
  const result = await restoreBackup(service, documentSource(fixture.output.backup));
  expect(result.tables.glossary_terms).toBe(1);
  expect(result.tables.comments).toBe(1);
  expect(result.tables.language_requests).toBe(1);
  expect(result.tables.language_request_votes).toBe(1);
  expect((await service.exportFiles(SYSTEM, {})).files).toEqual(fixture.output.export.files);
  expect(
    (await service.listLanguageRequests(ANONYMOUS, {})).requests.map((row) => [row.tag, row.votes]),
  ).toEqual([["eo", 1]]);
});
