// SPDX-License-Identifier: MIT
/** Markdown documents through the CLI: uploaded, downloaded and deleted as whole files. */
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { type ExportFile, type ExportResult, sha256Hex } from "@quaso/core";
import { DownloadState } from "../download_state.ts";
import { collectSources } from "../files.ts";
import { loadProject } from "../config.ts";
import { CONFIG, fakeFetch, jsonResponse, runCli, withProject } from "../test_helpers.ts";

const ENV = { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: "qso_key" };

const ARTICLE = "The moment has arrived\n\nWhat was once dirt now has a name.\n";
const GERMAN = "Der Moment ist gekommen\n\nWas einst Erde war, hat nun einen Namen.\n";

const PROJECT = {
  "quaso.config.json": {
    ...CONFIG,
    files: [
      { source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" },
      { source: "text/en/**/*.md", translation: "text/{lang}/{path}" },
    ],
  },
  "src/locales/en/common.json": '{ "play": "Play" }\n',
  "text/en/news/city_founded.md": ARTICLE,
};

function file(path: string, language: string, content: string): ExportFile {
  return { path, language, content, sha256: sha256Hex(content) };
}

function server(files: ExportFile[]) {
  return fakeFetch(() =>
    jsonResponse({
      schemaVersion: 1,
      revision: 5,
      sourceLanguage: "en",
      files,
    } satisfies ExportResult),
  );
}

const read = (dir: string, path: string) => fs.readFile(join(dir, ...path.split("/")), "utf8");
const exists = (dir: string, path: string) =>
  fs.stat(join(dir, ...path.split("/"))).then(
    () => true,
    () => false,
  );

test("Markdown files are source files, known to the instance below their glob's folder", async () => {
  await withProject(PROJECT, async (dir) => {
    const sources = await collectSources(await loadProject(dir));
    assertEquals(
      sources.files.map((source) => [source.server, source.local]),
      [
        ["common.json", "src/locales/en/common.json"],
        ["news/city_founded.md", "text/en/news/city_founded.md"],
      ],
    );
  });
});

test("upload sends a document's text as it is, without looking for a descriptions sidecar", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() =>
      jsonResponse({
        dryRun: false,
        uploadId: 1,
        files: [],
        added: [],
        changed: [],
        removed: [],
        restored: [],
        renamed: [],
        renameSuggestions: [],
        hiddenFiles: [],
        languagesAdded: [],
        warnings: [],
        job: null,
        revision: 3,
      }),
    );
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 0, run.stderr);
    const request = await fetch.requests[0].json();
    assertEquals(request.files, [
      {
        path: "common.json",
        repoPath: "src/locales/en/common.json",
        content: '{ "play": "Play" }\n',
      },
      { path: "news/city_founded.md", repoPath: "text/en/news/city_founded.md", content: ARTICLE },
    ]);
  });
});

test("download writes a document where the translation pattern says, and leaves it alone after", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([
      file("common.json", "de", '{ "play": "Spielen" }\n'),
      file("news/city_founded.md", "de", GERMAN),
    ]);
    const first = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    assertEquals(first.code, 0, first.stderr);
    assertEquals(await read(dir, "text/de/news/city_founded.md"), GERMAN);
    assertStringIncludes(first.stdout, "created      text/de/news/city_founded.md");
    const second = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    assertStringIncludes(second.stdout, "Everything is up to date (2 files).");
  });
});

test("download deletes a document the instance has nothing for, and reports it", async () => {
  await withProject(PROJECT, async (dir) => {
    const translated = server([file("news/city_founded.md", "de", GERMAN)]);
    const first = await runCli(["download"], { cwd: dir, env: ENV, fetch: translated });
    assertEquals(first.code, 0, first.stderr);
    const fetch = server([file("news/city_founded.md", "de", "")]);
    const dry = await runCli(["download", "--dry-run"], { cwd: dir, env: ENV, fetch });
    assertStringIncludes(dry.stdout, "would delete text/de/news/city_founded.md");
    assertEquals(await exists(dir, "text/de/news/city_founded.md"), true);
    const run = await runCli(["download", "--json"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 0, run.stderr);
    assertEquals(JSON.parse(run.stdout).result.removed, [
      { path: "text/de/news/city_founded.md", file: "news/city_founded.md", language: "de" },
    ]);
    assertEquals(await exists(dir, "text/de/news/city_founded.md"), false);
    const again = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    assertStringIncludes(again.stdout, "Everything is up to date (1 file).");
  });
});

test("download keeps a document edited in the repository, even when the instance has nothing for it", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([file("news/city_founded.md", "de", GERMAN)]);
    const first = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    assertEquals(first.code, 0, first.stderr);
    const edited = GERMAN.replace("Namen.", "Namen!");
    await fs.writeFile(join(dir, "text/de/news/city_founded.md"), edited);
    const kept = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    assertEquals(kept.code, 6);
    assertStringIncludes(kept.stdout, "local edit   de  news/city_founded.md › (whole file)");
    assertEquals(await read(dir, "text/de/news/city_founded.md"), edited);
    const nothing = server([file("news/city_founded.md", "de", "")]);
    const stillKept = await runCli(["download"], { cwd: dir, env: ENV, fetch: nothing });
    assertEquals(stillKept.code, 6);
    assertEquals(await exists(dir, "text/de/news/city_founded.md"), true);
    const overwritten = await runCli(["download", "--overwrite-local"], {
      cwd: dir,
      env: ENV,
      fetch,
    });
    assertEquals(overwritten.code, 0, overwritten.stderr);
    assertEquals(await read(dir, "text/de/news/city_founded.md"), GERMAN);
  });
});

test("download --prune deletes a document whose source is gone, never other kinds of files", async () => {
  await withProject(
    {
      ...PROJECT,
      "text/de/news/old_story.md": "Alt\n",
      "text/de/news/notes.txt": "kept\n",
    },
    async (dir) => {
      const fetch = server([file("news/city_founded.md", "de", GERMAN)]);
      const run = await runCli(["download", "--prune"], { cwd: dir, env: ENV, fetch });
      assertEquals(run.code, 0, run.stderr);
      assertStringIncludes(run.stdout, "deleted      text/de/news/old_story.md");
      assertEquals(await exists(dir, "text/de/news/old_story.md"), false);
      assertEquals(await exists(dir, "text/de/news/notes.txt"), true);
    },
  );
});

test("the download baseline compares a document whole, whatever its final newline", async () => {
  await withProject(PROJECT, async (dir) => {
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    const state = await DownloadState.load(project, sources, "https://quaso.test");
    const bytes = (text: string) => new TextEncoder().encode(text);
    const path = "text/de/news/city_founded.md";
    const noBaseline = state.conflicts(path, bytes(GERMAN), bytes(GERMAN), ARTICLE, "markdown");
    assertEquals(noBaseline, []);
    const sourceCopy = state.conflicts(path, bytes(ARTICLE), bytes(GERMAN), ARTICLE, "markdown");
    assertEquals(sourceCopy, [], "a copy of the English isn't an edit");
    const edited = state.conflicts(
      path,
      bytes("Anders\n\nText."),
      bytes(GERMAN),
      ARTICLE,
      "markdown",
    );
    assertEquals(edited, ["(whole file)"]);
    state.remember(path, bytes(GERMAN));
    const finalNewline = state.conflicts(
      path,
      bytes(GERMAN.trimEnd()),
      bytes(""),
      ARTICLE,
      "markdown",
    );
    assertEquals(finalNewline, [], "the last download, without its final newline, is no edit");
    assert(state.conflicts(path, bytes("Edited"), bytes(""), ARTICLE, "markdown").length === 1);
  });
});
