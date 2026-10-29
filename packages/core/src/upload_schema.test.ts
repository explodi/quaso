// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { FileContent, RepoPath, UploadRequest } from "./api.ts";
import { toJsonSchema, validate } from "./schema.ts";

test("uploads require the repository path separately from the server identity", () => {
  const file = { path: "menu.json", repoPath: "src/locales/en/menu.json", content: "{}" };
  expect(validate(UploadRequest, { files: [file] })).toStrictEqual({
    ok: true,
    value: { files: [file] },
  });
  expect(validate(UploadRequest, { files: [{ path: "menu.json", content: "{}" }] }).ok).toBe(false);
  expect(validate(FileContent, { path: "menu.json", content: "{}" }).ok).toBe(true);
  const schema = toJsonSchema(UploadRequest) as {
    properties: { files: { items: { required: string[] } } };
  };
  expect(schema.properties.files.items.required).toStrictEqual(["path", "content", "repoPath"]);
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
    expect(validate(RepoPath, path).ok).toBe(false);
  });
}

test("repository paths allow a 512-character relative path", () => {
  expect(validate(RepoPath, "x".repeat(507) + ".json").ok).toBe(true);
});
