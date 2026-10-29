// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SYSTEM_AUTHOR } from "./actors.ts";
import { initializeUploadSql, UPLOAD_CASES } from "./testing/upload_cases.ts";
import { planUpload } from "./upload_plan.ts";
import { readUploadSnapshot } from "./upload_snapshot.ts";

for (const testCase of UPLOAD_CASES) {
  test(`async SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}

test("upload decision is repeatable and does not mutate its snapshot", async () => {
  const opened = openAsyncSqlite(":memory:");
  try {
    await initializeUploadSql(opened.sql);
    const request = {
      files: [{ path: "menu.json", repoPath: "menu.json", content: '{"title":"Bonjour"}' }],
      languages: ["fr", "de"],
      sourceLanguage: "fr",
      limits: [{ file: "menu.json", key: "title", maxLength: 5 }],
    };
    const { revision, state } = await readUploadSnapshot(opened.sql, request, "test");
    const before = JSON.stringify(state);
    const plan = planUpload(state, request, SYSTEM_AUTHOR, revision, 100, true);
    expect(plan).toStrictEqual(planUpload(state, request, SYSTEM_AUTHOR, revision, 100, true));
    expect(JSON.stringify(state)).toStrictEqual(before);
    expect(plan.result.languagesAdded).toStrictEqual(["de"]);
    expect(plan.result.job).toStrictEqual({ id: 1 });
  } finally {
    opened.close();
  }
});
