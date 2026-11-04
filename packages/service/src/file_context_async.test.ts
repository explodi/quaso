// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { fileContextRequest } from "./jobs/file_context.ts";
import { defaultSettings } from "./settings.ts";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { FILE_CONTEXT_CASES } from "./testing/file_context_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
for (const testCase of FILE_CONTEXT_CASES) {
  test(`async file context on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}

test("file context identifies the configured source language without relabeling its text", () => {
  const settings = { ...defaultSettings("test"), sourceLanguage: "fr" };
  const source = '{"key":"play","english":"Jouer"}';
  const request = fileContextRequest(settings, "test", "menu.json", source);
  expect(request.prompt).toContain(
    'The source language is French (fr). The "english" fields contain source text in that language.',
  );
  expect(request.prompt).toContain(source);
});
