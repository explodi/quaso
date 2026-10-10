// SPDX-License-Identifier: MIT
import { beforeEach, expect, it } from "vitest";
import { createAsyncService, SYSTEM } from "@quaso/service";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { sql } from "./env.ts";

beforeEach(() => resetUploadSql(sql));
it("flags both duplicate keys on D1 and clears both after a correction", async () => {
  const service = createAsyncService({
    sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "test",
  });
  await service.start();
  await service.upload(SYSTEM, {
    languages: ["de"],
    files: [
      { path: "a.json", repoPath: "a.json", content: '{"barn":"Storage Barn","loft":"Hay Loft"}' },
    ],
  });
  await service.importTranslations(SYSTEM, {
    language: "de",
    as: "blue",
    files: [{ path: "a.json", content: '{"barn":"Scheune","loft":"Scheune"}' }],
  });
  const qa = await service.listStrings(SYSTEM, { language: "de", state: "qa" });
  expect(qa.total).toBe(2);
  expect(
    (await service.getString(SYSTEM, { id: qa.strings[0].id, language: "de" })).checks[0].check,
  ).toBe("duplicate_translation");
  await service.importTranslations(SYSTEM, {
    language: "de",
    as: "blue",
    overwrite: true,
    files: [{ path: "a.json", content: '{"loft":"Heuboden"}' }],
  });
  expect((await service.listStrings(SYSTEM, { language: "de", state: "qa" })).total).toBe(0);
});
