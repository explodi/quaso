// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { SYSTEM } from "./api.ts";
import { getRevision } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { count, jsonFile, startTestService, type TestInstance } from "./test_helpers.ts";
import { decideContext } from "./upload_contexts.ts";

test("no file, and none before: nothing happens", () => {
  expect(decideContext("Written here", null, null)).toStrictEqual({ kind: "unchanged" });
});

test("a new file sets a blank context", () => {
  expect(decideContext("", null, "From file")).toStrictEqual({
    kind: "set",
    text: "From file",
    uploaded: "From file",
  });
});

test("a new file replaces different text written on the website", () => {
  expect(decideContext("Written here", null, "From file")).toStrictEqual({
    kind: "replaced",
    text: "From file",
    uploaded: "From file",
  });
});

test("a new file with the text already written only links them", () => {
  expect(decideContext("Same", null, "Same")).toStrictEqual({
    kind: "matched",
    text: "Same",
    uploaded: "Same",
  });
});

test("an unchanged file with an unedited context: nothing happens", () => {
  expect(decideContext("From file", "From file", "From file")).toStrictEqual({ kind: "unchanged" });
});

test("an unchanged file never overwrites a website edit", () => {
  expect(decideContext("Edited", "From file", "From file")).toStrictEqual({ kind: "edited" });
});

test("an unchanged file never restores a context cleared on the website", () => {
  expect(decideContext("", "From file", "From file")).toStrictEqual({ kind: "edited" });
});

test("a changed file updates an unedited context", () => {
  expect(decideContext("Old", "Old", "New")).toStrictEqual({
    kind: "set",
    text: "New",
    uploaded: "New",
  });
});

test("a changed file wins over a website edit", () => {
  expect(decideContext("Edited", "Old", "New")).toStrictEqual({
    kind: "replaced",
    text: "New",
    uploaded: "New",
  });
});

test("a changed file updates a context cleared on the website, with nothing to warn about", () => {
  expect(decideContext("", "Old", "New")).toStrictEqual({
    kind: "set",
    text: "New",
    uploaded: "New",
  });
});

test("a changed file that now says what the website says only links them", () => {
  expect(decideContext("Edited", "Old", "Edited")).toStrictEqual({
    kind: "matched",
    text: "Edited",
    uploaded: "Edited",
  });
});

test("a deleted file clears the text it gave", () => {
  expect(decideContext("From file", "From file", null)).toStrictEqual({
    kind: "cleared",
    text: "",
    uploaded: null,
  });
});

test("a deleted file leaves a website edit in place, no longer tied to a file", () => {
  expect(decideContext("Edited", "From file", null)).toStrictEqual({
    kind: "detached",
    text: "Edited",
    uploaded: null,
  });
});

test("a blank file counts as no file", () => {
  expect(decideContext("Written here", null, " \n ")).toStrictEqual({ kind: "unchanged" });
  expect(decideContext("From file", "From file", "")).toStrictEqual({
    kind: "cleared",
    text: "",
    uploaded: null,
  });
});

const COMMON = { title: "Quest" };
const MENU = { play: "Play" };

type Uploaded = { context?: string; folders?: { path: string; context: string }[] };

/** A full upload, from a client that reads context files unless `older` says otherwise. */
function upload(
  instance: TestInstance,
  { context, folders = [] }: Uploaded,
  options: { dryRun?: boolean; older?: boolean } = {},
) {
  return instance.service.upload(SYSTEM, {
    files: [
      {
        ...jsonFile("common.json", COMMON),
        repoPath: "src/en/common.json",
        ...(context === undefined ? {} : { context }),
      },
      { ...jsonFile("menus/main.json", MENU), repoPath: "src/en/menus/main.json" },
    ],
    ...(options.older ? {} : { folderContexts: folders }),
    ...(options.dryRun ? { dryRun: true } : {}),
  });
}

function fileRow(instance: TestInstance) {
  return instance.sql.query("SELECT context, uploaded_context FROM files WHERE id = 1")[0];
}

function folderRows(instance: TestInstance) {
  return instance.sql.query("SELECT path, context, uploaded_context FROM folders ORDER BY path");
}

test("an upload stores context files on the file and on its folders", async () => {
  using instance = await startTestService();
  const result = await upload(instance, {
    context: "The title screen.",
    folders: [
      { path: "", context: "A sailing game." },
      { path: "menus", context: "Menu buttons." },
    ],
  });
  expect(fileRow(instance)).toStrictEqual({
    context: "The title screen.",
    uploaded_context: "The title screen.",
  });
  expect(folderRows(instance)).toStrictEqual([
    { path: "", context: "A sailing game.", uploaded_context: "A sailing game." },
    { path: "menus", context: "Menu buttons.", uploaded_context: "Menu buttons." },
  ]);
  expect(result.contexts).toStrictEqual([
    { target: "file", path: "common.json", change: "set" },
    { target: "folder", path: "", change: "set" },
    { target: "folder", path: "menus", change: "set" },
  ]);
  expect(result.warnings).toStrictEqual([]);
});

test("a website edit survives uploads of the unchanged file, which warn each time", async () => {
  using instance = await startTestService();
  await upload(instance, { context: "From file" });
  await instance.service.updateFile(SYSTEM, { id: 1, context: "Edited" });
  const first = await upload(instance, { context: "From file" });
  const second = await upload(instance, { context: "From file" });
  expect(fileRow(instance)).toStrictEqual({ context: "Edited", uploaded_context: "From file" });
  expect(first.warnings).toStrictEqual([
    "src/en/common.json.quaso: this context was edited on the website, so the upload kept that text. " +
      "To keep it, copy it into the file. To drop it, choose Use the file's text in Settings.",
  ]);
  expect(second.warnings).toStrictEqual(first.warnings);
  expect(second.uploadId).toBe(null);
});

test("a changed file replaces a website edit, and says so", async () => {
  using instance = await startTestService();
  await upload(instance, { context: "Old" });
  await instance.service.updateFile(SYSTEM, { id: 1, context: "Edited" });
  const result = await upload(instance, { context: "New" });
  expect(fileRow(instance)).toStrictEqual({ context: "New", uploaded_context: "New" });
  expect(result.warnings).toStrictEqual([
    "src/en/common.json.quaso replaced a different context that was written on the website.",
  ]);
});

test("a first context file replaces a folder context written on the website", async () => {
  using instance = await startTestService();
  await upload(instance, {});
  await instance.service.updateFolder(SYSTEM, { path: "menus", context: "Written here" });
  const result = await upload(instance, { folders: [{ path: "menus", context: "From file" }] });
  expect(folderRows(instance)).toStrictEqual([
    { path: "menus", context: "From file", uploaded_context: "From file" },
  ]);
  expect(result.warnings).toStrictEqual([
    "context.quaso in folder menus replaced a different context that was written on the website.",
  ]);
});

test("deleting a context file clears the context it gave", async () => {
  using instance = await startTestService();
  await upload(instance, {
    context: "From file",
    folders: [{ path: "menus", context: "From file" }],
  });
  const result = await upload(instance, {});
  expect(fileRow(instance)).toStrictEqual({ context: "", uploaded_context: null });
  expect(folderRows(instance)).toStrictEqual([]);
  expect(result.contexts).toStrictEqual([
    { target: "file", path: "common.json", change: "cleared" },
    { target: "folder", path: "menus", change: "cleared" },
  ]);
  expect(result.warnings).toStrictEqual([]);
});

test("deleting a context file leaves a website edit, no longer tied to the file", async () => {
  using instance = await startTestService();
  await upload(instance, { folders: [{ path: "", context: "From file" }] });
  await instance.service.updateFolder(SYSTEM, { path: "", context: "Edited" });
  const result = await upload(instance, {});
  expect(folderRows(instance)).toStrictEqual([
    { path: "", context: "Edited", uploaded_context: null },
  ]);
  expect(result.warnings).toStrictEqual([
    "The top folder's context.quaso is gone, but its context was edited on the website, so that text stays.",
  ]);
});

test("contexts written on the website alone are never touched", async () => {
  using instance = await startTestService();
  await upload(instance, {});
  await instance.service.updateFile(SYSTEM, { id: 1, context: "Written here" });
  await instance.service.updateFolder(SYSTEM, { path: "menus", context: "Also here" });
  const result = await upload(instance, {});
  expect(fileRow(instance)).toStrictEqual({ context: "Written here", uploaded_context: null });
  expect(folderRows(instance)).toStrictEqual([
    { path: "menus", context: "Also here", uploaded_context: null },
  ]);
  expect(result.uploadId).toBe(null);
  expect(result.warnings).toStrictEqual([]);
});

test("a client that doesn't read context files leaves every context alone", async () => {
  using instance = await startTestService();
  await upload(instance, {
    context: "From file",
    folders: [{ path: "menus", context: "From file" }],
  });
  const result = await upload(instance, {}, { older: true });
  expect(fileRow(instance)).toStrictEqual({
    context: "From file",
    uploaded_context: "From file",
  });
  expect(folderRows(instance)).toStrictEqual([
    { path: "menus", context: "From file", uploaded_context: "From file" },
  ]);
  expect(result.contexts).toStrictEqual([]);
});

test("a partial upload updates the named file's context and leaves folders alone", async () => {
  using instance = await startTestService();
  await upload(instance, { folders: [{ path: "menus", context: "From file" }] });
  const result = await instance.service.upload(SYSTEM, {
    files: [
      { ...jsonFile("common.json", COMMON), repoPath: "src/en/common.json", context: "Named" },
    ],
    partial: true,
    folderContexts: [],
  });
  expect(fileRow(instance)).toStrictEqual({ context: "Named", uploaded_context: "Named" });
  expect(folderRows(instance)).toStrictEqual([
    { path: "menus", context: "From file", uploaded_context: "From file" },
  ]);
  expect(result.contexts).toStrictEqual([{ target: "file", path: "common.json", change: "set" }]);
});

test("a hidden file keeps its context, ready for when it returns", async () => {
  using instance = await startTestService();
  await upload(instance, { context: "From file" });
  await instance.service.upload(SYSTEM, {
    files: [{ ...jsonFile("menus/main.json", MENU), repoPath: "src/en/menus/main.json" }],
    folderContexts: [],
  });
  expect(fileRow(instance)).toStrictEqual({
    context: "From file",
    uploaded_context: "From file",
  });
});

test("a dry run reports what would change and saves nothing", async () => {
  using instance = await startTestService();
  await upload(instance, {});
  const before = getRevision(instance.sql);
  const result = await upload(instance, { context: "From file" }, { dryRun: true });
  expect(result.contexts).toStrictEqual([{ target: "file", path: "common.json", change: "set" }]);
  expect(fileRow(instance)).toStrictEqual({ context: "", uploaded_context: null });
  expect(getRevision(instance.sql)).toBe(before);
});

test("an upload that only changes a context is recorded", async () => {
  using instance = await startTestService();
  await upload(instance, {});
  const uploads = count(instance.sql, "uploads");
  const result = await upload(instance, { context: "From file" });
  expect(result.uploadId).not.toBe(null);
  expect(count(instance.sql, "uploads")).toBe(uploads + 1);
  const [activity] = instance.sql.query<{ summary: string }>(
    "SELECT summary FROM activity ORDER BY id DESC LIMIT 1",
  );
  expect(activity.summary).toBe("Upload: 1 context updated");
});

test("an upload with a folder's context twice is refused", async () => {
  using instance = await startTestService();
  const twice = [
    { path: "menus", context: "One" },
    { path: "menus", context: "Two" },
  ];
  await expect(upload(instance, { folders: twice })).rejects.toThrow(ServiceError);
});
