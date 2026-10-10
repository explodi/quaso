// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "node:path";
import type { UploadRequest, UploadResult } from "@quaso/core";
import { CliError } from "../errors.ts";
import { CONFIG, fakeFetch, jobInfo, jsonResponse, runCli, withProject } from "../test_helpers.ts";
import { parseRename, renameCommand } from "./upload.ts";

const ENV = { QUASO_HOSTNAME: "quaso.test", QUASO_API_KEY: "qso_key" };

function result(overrides: Partial<UploadResult> = {}): UploadResult {
  return {
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
    ...overrides,
  };
}

const PROJECT = {
  "quaso.config.json": {
    ...CONFIG,
    limits: [{ file: "common.json", key: "title", maxLength: 30 }],
    pluralExclusions: [{ file: "common.json", key: "power" }],
  },
  "src/locales/en/common.json": '{ "title": "Quest", "saved": "Saved." }\n',
  "src/locales/en/menus/main.json": '{ "play": "Play" }\n',
};

test("upload notices new local translations and prints an import command without importing automatically", async () => {
  await withProject(
    { ...PROJECT, "src/locales/de/common.json": '{"title":"Abenteuer"}' },
    async (dir) => {
      const fetch = fakeFetch(() =>
        jsonResponse(result({ added: [{ file: "common.json", key: "title" }] })),
      );
      const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
      assertEquals(run.code, 0, run.stderr);
      assertStringIncludes(run.stdout, "1 new or changed string already has de");
      assertStringIncludes(run.stdout, "quaso import --as blue --language de --file common.json");
      assertEquals(fetch.requests.length, 1);
    },
  );
});

test("repository-owned translations import as blue on every upload with overwrite and preserve identical wording", async () => {
  await withProject(
    {
      ...PROJECT,
      "quaso.config.json": { ...PROJECT["quaso.config.json"], translationsInRepository: ["de"] },
      "src/locales/de/common.json": '{"title":"Abenteuer"}',
    },
    async (dir) => {
      const fetch = fakeFetch((request) =>
        jsonResponse(
          new URL(request.url).pathname.endsWith("/imports")
            ? { language: "de", imported: 1, refused: [] }
            : result(),
        ),
      );
      const run = await runCli(["upload", "--json"], { cwd: dir, env: ENV, fetch });
      assertEquals(run.code, 0, run.stderr);
      assertEquals(await fetch.requests[1].json(), {
        language: "de",
        as: "blue",
        overwrite: true,
        keepIdentical: true,
        files: [{ path: "common.json", content: '{"title":"Abenteuer"}' }],
      });
      assertEquals(JSON.parse(run.stdout).result.imports[0].imported, 1);
    },
  );
});

test("upload can import an explicitly selected language and dry runs only report that plan", async () => {
  await withProject(
    { ...PROJECT, "src/locales/de/common.json": '{"title":"Abenteuer"}' },
    async (dir) => {
      const fetch = fakeFetch((request) =>
        jsonResponse(
          new URL(request.url).pathname.endsWith("/imports")
            ? { language: "de", imported: 1, refused: [] }
            : result(),
        ),
      );
      const run = await runCli(["upload", "--import-translations", "de:green"], {
        cwd: dir,
        env: ENV,
        fetch,
      });
      assertEquals(run.code, 0, run.stderr);
      assertEquals((await fetch.requests[1].json()).as, "green");
      const dryFetch = fakeFetch(() => jsonResponse(result({ dryRun: true })));
      const dry = await runCli(["upload", "--import-translations", "de", "--dry-run"], {
        cwd: dir,
        env: ENV,
        fetch: dryFetch,
      });
      assertEquals(dry.code, 0, dry.stderr);
      assertEquals(dryFetch.requests.length, 1);
      assertStringIncludes(dry.stdout, "Would import de as blue");
    },
  );
});

test("parseRename: old=new, file:old=new, and JSON array key paths", () => {
  const file = (name: string) => (name === "src/locales/en/common.json" ? "common.json" : name);
  assertEquals(parseRename("menu.start=menu.play", file), { from: "menu.start", to: "menu.play" });
  assertEquals(parseRename("common.json:coins#plural=gold#plural", file), {
    file: "common.json",
    from: "coins#plural",
    to: "gold#plural",
  });
  assertEquals(parseRename("src/locales/en/common.json:a=b", file), {
    file: "common.json",
    from: "a",
    to: "b",
  });
  assertEquals(parseRename('common.json:["a=b", "c:d"]=["e"]', file), {
    file: "common.json",
    from: '["a=b", "c:d"]',
    to: '["e"]',
  });
  assertEquals(parseRename("a=b=c", file), { from: "a", to: "b=c" });
  for (const bad of ["a", "=b", "a=", '["a"', '["a"]b', "[1,{}]=a", "[]=a"]) {
    assertEquals(assertThrows(() => parseRename(bad, file), CliError).exitCode, 2, bad);
  }
});

test("renameCommand is quoted for the shell", () => {
  assertEquals(
    renameCommand({ file: "common.json", from: "coins#plural", to: "gold#plural" }),
    "quaso upload --rename common.json:coins#plural=gold#plural",
  );
  assertEquals(
    renameCommand({ file: "menus/main.json", from: '["a.b"]', to: '["a", "b"]' }),
    `quaso upload --rename 'menus/main.json:["a.b"]=["a", "b"]'`,
  );
  assertEquals(
    renameCommand(
      { file: "common.json", from: "saved", to: "gameSaved" },
      { file: "common.json", from: "hints.0", to: "tips.0" },
    ),
    "quaso upload --rename common.json:saved=gameSaved --rename common.json:hints.0=tips.0",
  );
});

// Regression: the suggested command for a key with "=" renamed the wrong keys.
test("every rename suggestion reads back as it was made", () => {
  const suggestions = [
    { file: "common.json", from: "x = y", to: "equation" },
    { file: "common.json", from: "a=b", to: "c=d" },
    { file: "common.json", from: "x = y#plural", to: "eq#plural" },
    { file: "common.json", from: '"quoted"', to: '"also"' },
    { file: "common.json", from: '["a.b"]#plural', to: '["c"]#plural' },
    { file: "common.json", from: '["x = y"]', to: "z" },
    { file: "menus/main.json", from: "Press [Enter]", to: "menu: go" },
    { file: "common.json", from: "saved", to: "gameSaved" },
  ];
  for (const suggestion of suggestions) {
    const command = renameCommand(suggestion);
    // The argument as the shell passes it: the command quotes it in single quotes, if at all.
    const arg = command
      .slice("quaso upload --rename ".length)
      .replace(/^'(.*)'$/, "$1")
      .replaceAll(`'"'"'`, "'");
    assertEquals(
      parseRename(arg, (file) => file),
      suggestion,
      command,
    );
  }
  assertEquals(
    renameCommand(suggestions[0]),
    `quaso upload --rename 'common.json:"x = y"=equation'`,
  );
});

test("parseRename: a JSON string for a key with = in it", () => {
  const file = (name: string) => name;
  assertEquals(parseRename('"x = y"=equation', file), { from: "x = y", to: "equation" });
  assertEquals(parseRename('common.json:"a\\"b=c"="d"', file), {
    file: "common.json",
    from: 'a"b=c',
    to: "d",
  });
  for (const bad of ['"x = y', '"x"y=z', '""=a', 'a=""', '["a"]#other=b']) {
    assertEquals(assertThrows(() => parseRename(bad, file), CliError).exitCode, 2, bad);
  }
});

// Regression (CLI-5): a committed link sent a file from outside the project as English.
test("upload refuses to read a source file through a link that leads outside", async () => {
  if (process.platform === "win32") return;
  await withProject({ "secret/creds.json": '{ "token": "SECRET-123" }' }, async (outside) => {
    await withProject(PROJECT, async (dir) => {
      await fs.symlink(
        join(outside, "secret", "creds.json"),
        join(dir, "src", "locales", "en", "creds.json"),
      );
      const fetch = fakeFetch(() => jsonResponse(result()));
      const run = await runCli(["upload", "--dry-run"], { cwd: dir, env: ENV, fetch });
      assertEquals(run.code, 2);
      assertStringIncludes(
        run.stderr,
        "Refusing to read src/locales/en/creds.json: a symbolic link leads outside",
      );
      assertEquals(fetch.requests.length, 0);
      // A link inside the project is fine.
      await fs.rm(join(dir, "src", "locales", "en", "creds.json"));
      await fs.writeFile(join(dir, "shared.json"), '{ "ok": "OK" }');
      await fs.symlink(join(dir, "shared.json"), join(dir, "src", "locales", "en", "shared.json"));
      const inside = await runCli(["upload", "--dry-run"], { cwd: dir, env: ENV, fetch });
      assertEquals(inside.code, 0, inside.stderr);
    });
  });
});

test("upload sends every source file unchanged, with the config's settings", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() => jsonResponse(result()));
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 0, run.stderr);
    const request = fetch.requests[0];
    assertEquals(request.url, "https://quaso.test/api/v1/sources");
    const body: UploadRequest = await request.json();
    assertEquals(body, {
      files: [
        {
          path: "common.json",
          repoPath: "src/locales/en/common.json",
          content: '{ "title": "Quest", "saved": "Saved." }\n',
        },
        {
          path: "menus/main.json",
          repoPath: "src/locales/en/menus/main.json",
          content: '{ "play": "Play" }\n',
        },
      ],
      sourceLanguage: "en",
      languages: ["de", "pl"],
      limits: [{ file: "common.json", key: "title", maxLength: 30 }],
      pluralExclusions: [{ file: "common.json", key: "power" }],
    });
  });
});

test("upload --file is partial; --dry-run and --rename are sent", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() => jsonResponse(result({ dryRun: true, uploadId: null })));
    const run = await runCli(
      [
        "upload",
        "--file",
        "src/locales/en/menus/main.json",
        "--dry-run",
        "--rename",
        "saved=gameSaved",
      ],
      { cwd: dir, env: ENV, fetch },
    );
    assertEquals(run.code, 0, run.stderr);
    const body: UploadRequest = await fetch.requests[0].json();
    assertEquals(
      body.files.map((file) => file.path),
      ["menus/main.json"],
    );
    assertEquals(body.partial, true);
    assertEquals(body.dryRun, true);
    assertEquals(body.renames, [{ from: "saved", to: "gameSaved" }]);
    assertStringIncludes(run.stdout, "Dry run: nothing was saved.");
  });
});

test("upload prints changes with local paths, rename commands and warnings", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch((request) =>
      new URL(request.url).pathname === "/api/v1/jobs/7"
        ? jsonResponse(jobInfo({ id: 7 }))
        : jsonResponse(
            result({
              files: [
                {
                  path: "common.json",
                  status: "updated",
                  added: 1,
                  changed: 0,
                  removed: 1,
                  restored: 0,
                  moved: 0,
                  unchanged: 1,
                },
              ],
              added: [{ file: "common.json", key: "gameSaved" }],
              removed: [{ file: "common.json", key: "saved" }],
              renameSuggestions: [{ file: "common.json", from: "saved", to: "gameSaved" }],
              warnings: ["The limit for common.json › nope names a string the server doesn't have"],
              job: { id: 7 },
            }),
          ),
    );
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 0);
    assertStringIncludes(run.stdout, "src/locales/en/common.json  updated  1 added, 1 removed");
    assertStringIncludes(run.stdout, "src/locales/en/common.json › gameSaved");
    assertStringIncludes(run.stdout, "quaso upload --rename common.json:saved=gameSaved");
    assertStringIncludes(run.stdout, "names a string the server doesn't have");
    assertStringIncludes(run.stdout, "Translation job 7 is queued");
    assertStringIncludes(run.stderr, "Uploading 2 files to https://quaso.test");

    const json = await runCli(["upload", "--json", "--wait"], { cwd: dir, env: ENV, fetch });
    const document = JSON.parse(json.stdout);
    assertEquals(
      document.result.renameSuggestions[0].command,
      "quaso upload --rename common.json:saved=gameSaved",
    );
    assertEquals(document.result.files[0].localPath, "src/locales/en/common.json");
    assertEquals(document.result.wait.job.id, 7);
    assertEquals(document.result.wait.job.status, "done");
  });
});

test("upload --wait says when no job was queued", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() => jsonResponse(result({ uploadId: null })));
    const run = await runCli(["upload", "--wait"], { cwd: dir, env: ENV, fetch });
    assertStringIncludes(run.stdout, "Nothing changed");
    assertStringIncludes(run.stdout, "no automatic translation job");
  });
});

test("upload: invalid_source names the local file, line and column, exit code 5", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() =>
      jsonResponse(
        {
          error: {
            code: "invalid_source",
            message: "menus/main.json:1:3: Duplicate key",
            details: [
              {
                file: "menus/main.json",
                line: 1,
                column: 3,
                key: "play",
                message: 'Duplicate key "play"',
              },
            ],
          },
        },
        422,
      ),
    );
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 5);
    assertStringIncludes(run.stderr, "error: 1 source file can't be read.");
    assertStringIncludes(
      run.stderr,
      'src/locales/en/menus/main.json:1:3 › play: duplicate key "play"',
    );
  });
});

test("upload: a file that isn't UTF-8 is exit code 5, before anything is sent", async () => {
  await withProject(PROJECT, async (dir) => {
    await fs.writeFile(`${dir}/src/locales/en/bad.json`, new Uint8Array([0x7b, 0xff, 0x7d]));
    const fetch = fakeFetch(() => jsonResponse(result()));
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 5);
    assertStringIncludes(run.stderr, "src/locales/en/bad.json: isn't valid UTF-8 text");
    assertEquals(fetch.requests.length, 0);
  });
});

test("upload: validation errors about limits point to the config", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() =>
      jsonResponse(
        {
          error: {
            code: "validation_failed",
            message: "The request is invalid: limits[0].maxLength: must be at most 100000.",
            details: [{ path: "limits[0].maxLength", message: "must be at most 100000" }],
          },
        },
        400,
      ),
    );
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 2);
    assertStringIncludes(
      run.stderr,
      "quaso.config.json › limits[0].maxLength: must be at most 100000",
    );
  });
});

test("upload sends a guarded descriptions sidecar as metadata and leaves both repository files intact", async () => {
  const sidecar = '{"title":"The game name","unknown":"Report this"}';
  await withProject(
    { ...PROJECT, "src/locales/en/common.descriptions.json": sidecar },
    async (dir) => {
      const fetch = fakeFetch(() => jsonResponse(result()));
      const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
      assertEquals(run.code, 0, run.stderr);
      const sent = (await fetch.requests[0].json()) as UploadRequest;
      assertEquals(sent.files.length, 2);
      assertEquals(sent.files[0].descriptions, sidecar);
      assertEquals(sent.files[0].content, PROJECT["src/locales/en/common.json"]);
      assertEquals(
        await fs.readFile(join(dir, "src/locales/en/common.descriptions.json"), "utf8"),
        sidecar,
      );
    },
  );
});
