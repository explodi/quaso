// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
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
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain(
        "1 new string already has translations in repository files (de).",
      );
      expect(run.stdout).toContain(
        "Import them: quaso import --as blue --language de --file common.json",
      );
      expect(fetch.requests.length).toBe(1);
    },
  );
});

test("upload warns that local translations of changed strings translate the previous source text", async () => {
  await withProject(
    {
      ...PROJECT,
      "quaso.config.json": { ...PROJECT["quaso.config.json"], languages: ["de", "fr", "ja"] },
      "src/locales/de/common.json": '{"title":"Abenteuer"}',
      "src/locales/fr/common.json": '{"title":"Aventure"}',
    },
    async (dir) => {
      const fetch = fakeFetch(() =>
        jsonResponse(result({ changed: [{ file: "common.json", key: "title" }] })),
      );
      const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain(
        "1 changed string still has its previous translations in repository files (de, fr).",
      );
      expect(run.stdout).toContain("Those translate the old source text, so they weren't imported");
      expect(run.stdout).toContain(
        "If you updated them along with the source, import them: quaso import --as blue --language de --language fr --file common.json",
      );
      expect(run.stdout.includes("Import them:")).toBe(false);
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
      expect(run.code, run.stderr).toBe(0);
      expect(await fetch.requests[1].json()).toStrictEqual({
        language: "de",
        as: "blue",
        overwrite: true,
        keepIdentical: true,
        files: [{ path: "common.json", content: '{"title":"Abenteuer"}' }],
      });
      expect(JSON.parse(run.stdout).result.imports[0].imported).toBe(1);
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
      expect(run.code, run.stderr).toBe(0);
      expect((await fetch.requests[1].json()).as).toBe("green");
      const dryFetch = fakeFetch(() => jsonResponse(result({ dryRun: true })));
      const dry = await runCli(["upload", "--import-translations", "de", "--dry-run"], {
        cwd: dir,
        env: ENV,
        fetch: dryFetch,
      });
      expect(dry.code, dry.stderr).toBe(0);
      expect(dryFetch.requests.length).toBe(1);
      expect(dry.stdout).toContain("Would import de as blue");
    },
  );
});

test("parseRename: old=new, file:old=new, and JSON array key paths", () => {
  const file = (name: string) => (name === "src/locales/en/common.json" ? "common.json" : name);
  expect(parseRename("menu.start=menu.play", file)).toStrictEqual({
    from: "menu.start",
    to: "menu.play",
  });
  expect(parseRename("common.json:coins#plural=gold#plural", file)).toStrictEqual({
    file: "common.json",
    from: "coins#plural",
    to: "gold#plural",
  });
  expect(parseRename("src/locales/en/common.json:a=b", file)).toStrictEqual({
    file: "common.json",
    from: "a",
    to: "b",
  });
  expect(parseRename('common.json:["a=b", "c:d"]=["e"]', file)).toStrictEqual({
    file: "common.json",
    from: '["a=b", "c:d"]',
    to: '["e"]',
  });
  expect(parseRename("a=b=c", file)).toStrictEqual({ from: "a", to: "b=c" });
  for (const bad of ["a", "=b", "a=", '["a"', '["a"]b', "[1,{}]=a", "[]=a"]) {
    expect(() => parseRename(bad, file), bad).toThrow(
      expect.objectContaining({ constructor: CliError, exitCode: 2 }),
    );
  }
});

test("renameCommand is quoted for the shell", () => {
  expect(renameCommand({ file: "common.json", from: "coins#plural", to: "gold#plural" })).toBe(
    "quaso upload --rename common.json:coins#plural=gold#plural",
  );
  expect(
    renameCommand({ file: "menus/main.json", from: '["a.b"]', to: '["a", "b"]' }),
  ).toStrictEqual(`quaso upload --rename 'menus/main.json:["a.b"]=["a", "b"]'`);
  expect(
    renameCommand(
      { file: "common.json", from: "saved", to: "gameSaved" },
      { file: "common.json", from: "hints.0", to: "tips.0" },
    ),
  ).toStrictEqual(
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
    expect(
      parseRename(arg, (file) => file),
      command,
    ).toStrictEqual(suggestion);
  }
  expect(renameCommand(suggestions[0])).toStrictEqual(
    `quaso upload --rename 'common.json:"x = y"=equation'`,
  );
});

test("parseRename: a JSON string for a key with = in it", () => {
  const file = (name: string) => name;
  expect(parseRename('"x = y"=equation', file)).toStrictEqual({ from: "x = y", to: "equation" });
  expect(parseRename('common.json:"a\\"b=c"="d"', file)).toStrictEqual({
    file: "common.json",
    from: 'a"b=c',
    to: "d",
  });
  for (const bad of ['"x = y', '"x"y=z', '""=a', 'a=""', '["a"]#other=b']) {
    expect(() => parseRename(bad, file), bad).toThrow(
      expect.objectContaining({ constructor: CliError, exitCode: 2 }),
    );
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
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "Refusing to read src/locales/en/creds.json: src/locales/en/creds.json is a symbolic link",
      );
      expect(fetch.requests.length).toBe(0);
    });
  });
});

// Regression (audit QUASO-F2): a committed link to the ignored .env sent it as English.
test(
  "upload refuses a source file that links to another file of the project",
  { skip: process.platform === "win32" },
  async () => {
    await withProject({ ...PROJECT, ".env": "TOKEN=SECRET-123\n" }, async (dir) => {
      await fs.symlink(join("..", "..", "..", ".env"), join(dir, "src", "locales", "en", "x.json"));
      const fetch = fakeFetch(() => jsonResponse(result()));
      const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "Refusing to read src/locales/en/x.json: src/locales/en/x.json is a symbolic link",
      );
      expect(run.stderr).toContain("Replace src/locales/en/x.json with a regular file");
      expect(fetch.requests.length).toBe(0);
    });
  },
);

test(
  "upload refuses source files in a linked folder",
  { skip: process.platform === "win32" },
  async () => {
    await withProject(
      { "quaso.config.json": CONFIG, "shared/en/common.json": '{ "play": "Play" }\n' },
      async (dir) => {
        await fs.mkdir(join(dir, "src", "locales"), { recursive: true });
        await fs.symlink(join(dir, "shared", "en"), join(dir, "src", "locales", "en"));
        const fetch = fakeFetch(() => jsonResponse(result()));
        const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
        expect(run.code).toBe(2);
        expect(run.stderr).toContain(
          "Refusing to read src/locales/en/common.json: src/locales/en is a symbolic link",
        );
        expect(fetch.requests.length).toBe(0);
      },
    );
  },
);

test("upload sends every source file unchanged, with the config's settings", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() => jsonResponse(result()));
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    expect(run.code, run.stderr).toBe(0);
    const request = fetch.requests[0];
    expect(request.url).toBe("https://quaso.test/api/v1/sources");
    const body: UploadRequest = await request.json();
    expect(body).toStrictEqual({
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
    expect(run.code, run.stderr).toBe(0);
    const body: UploadRequest = await fetch.requests[0].json();
    expect(body.files.map((file) => file.path)).toStrictEqual(["menus/main.json"]);
    expect(body.partial).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.renames).toStrictEqual([{ from: "saved", to: "gameSaved" }]);
    expect(run.stdout).toContain("Dry run: nothing was saved.");
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
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("src/locales/en/common.json  updated  1 added, 1 removed");
    expect(run.stdout).toContain("src/locales/en/common.json › gameSaved");
    expect(run.stdout).toContain("quaso upload --rename common.json:saved=gameSaved");
    expect(run.stdout).toContain("names a string the server doesn't have");
    expect(run.stdout).toContain("Translation job 7 is queued");
    expect(run.stderr).toContain("Uploading 2 files to https://quaso.test");

    const json = await runCli(["upload", "--json", "--wait"], { cwd: dir, env: ENV, fetch });
    const document = JSON.parse(json.stdout);
    expect(document.result.renameSuggestions[0].command).toStrictEqual(
      "quaso upload --rename common.json:saved=gameSaved",
    );
    expect(document.result.files[0].localPath).toBe("src/locales/en/common.json");
    expect(document.result.wait.job.id).toBe(7);
    expect(document.result.wait.job.status).toBe("done");
  });
});

test("upload --wait says when no job was queued", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() => jsonResponse(result({ uploadId: null })));
    const run = await runCli(["upload", "--wait"], { cwd: dir, env: ENV, fetch });
    expect(run.stdout).toContain("Nothing changed");
    expect(run.stdout).toContain("no automatic translation job");
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
    expect(run.code).toBe(5);
    expect(run.stderr).toContain("error: 1 source file can't be read.");
    expect(run.stderr).toContain('src/locales/en/menus/main.json:1:3 › play: duplicate key "play"');
  });
});

test("upload: a file that isn't UTF-8 is exit code 5, before anything is sent", async () => {
  await withProject(PROJECT, async (dir) => {
    await fs.writeFile(`${dir}/src/locales/en/bad.json`, new Uint8Array([0x7b, 0xff, 0x7d]));
    const fetch = fakeFetch(() => jsonResponse(result()));
    const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
    expect(run.code).toBe(5);
    expect(run.stderr).toContain("src/locales/en/bad.json: isn't valid UTF-8 text");
    expect(fetch.requests.length).toBe(0);
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
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("quaso.config.json › limits[0].maxLength: must be at most 100000");
  });
});

test("upload sends a guarded descriptions sidecar as metadata and leaves both repository files intact", async () => {
  const sidecar = '{"title":"The game name","unknown":"Report this"}';
  await withProject(
    { ...PROJECT, "src/locales/en/common.descriptions.json": sidecar },
    async (dir) => {
      const fetch = fakeFetch(() => jsonResponse(result()));
      const run = await runCli(["upload"], { cwd: dir, env: ENV, fetch });
      expect(run.code, run.stderr).toBe(0);
      const sent = (await fetch.requests[0].json()) as UploadRequest;
      expect(sent.files.length).toBe(2);
      expect(sent.files[0].descriptions).toStrictEqual(sidecar);
      expect(sent.files[0].content).toStrictEqual(PROJECT["src/locales/en/common.json"]);
      expect(
        await fs.readFile(join(dir, "src/locales/en/common.descriptions.json"), "utf8"),
      ).toStrictEqual(sidecar);
    },
  );
});
