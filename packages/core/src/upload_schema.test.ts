// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { FileContent, RepoPath, UploadRequest } from "./api.ts";
import { toJsonSchema, validate } from "./schema.ts";

test("uploads require the repository path separately from the server identity", () => {
  const file = { path: "menu.json", repoPath: "src/locales/en/menu.json", content: "{}" };
  assertEquals(validate(UploadRequest, { files: [file] }), { ok: true, value: { files: [file] } });
  assertEquals(
    validate(UploadRequest, { files: [{ path: "menu.json", content: "{}" }] }).ok,
    false,
  );
  assertEquals(validate(FileContent, { path: "menu.json", content: "{}" }).ok, true);
  const schema = toJsonSchema(UploadRequest) as {
    properties: { files: { items: { required: string[] } } };
  };
  assertEquals(schema.properties.files.items.required, ["path", "content", "repoPath"]);
});

const INVALID = [
  "",
  "/src/menu.json",
  "C:/src/menu.json",
  "src\\menu.json",
  "./menu.json",
  "src/../menu.json",
  "src/./menu.json",
  "src//menu.json",
  "x".repeat(508) + ".json",
];
for (const path of INVALID) {
  test(`repository path rejects ${JSON.stringify(path).slice(0, 70)}`, () => {
    assertEquals(validate(RepoPath, path).ok, false);
  });
}

test("repository paths allow a 512-character relative path", () => {
  assertEquals(validate(RepoPath, "x".repeat(507) + ".json").ok, true);
});
