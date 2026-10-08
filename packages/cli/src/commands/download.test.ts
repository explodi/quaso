// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { type ExportFile, type ExportResult, sha256Hex } from "@quaso/core";
import { CONFIG, fakeFetch, jsonResponse, runCli, withProject } from "../test_helpers.ts";

const ENV = { QUASO_HOSTNAME: "http://quaso.test", QUASO_API_KEY: "qso_key" };

const PROJECT = {
  "quaso.config.json": CONFIG,
  "src/locales/en/common.json": '{ "play": "Play" }\n',
  "src/locales/en/menus/main.json": '{ "quit": "Quit" }\n',
};

function file(
  path: string,
  language: string,
  content: string,
  sha256 = sha256Hex(content),
): ExportFile {
  return { path, language, content, sha256 };
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

const FILES = [
  file("common.json", "de", '{ "play": "Spielen" }\n'),
  file("menus/main.json", "de", '{ "quit": "Beenden" }\n'),
  file("common.json", "pl", '{ "play": "Graj" }\n'),
  file("menus/main.json", "pl", '{ "quit": "Quit" }\n'),
];

test("download writes changed files only, creating folders", async () => {
  await withProject(
    { ...PROJECT, "src/locales/pl/common.json": '{ "play": "Graj" }\n' },
    async (dir) => {
      const fetch = server(FILES);
      const first = await runCli(["download", "--json"], { cwd: dir, env: ENV, fetch });
      assertEquals(first.code, 0, first.stderr);
      assertEquals(new URL(fetch.requests[0].url).searchParams.get("languages"), "de,pl");
      const result = JSON.parse(first.stdout).result;
      assertEquals(
        result.written.map((f: { path: string }) => f.path),
        [
          "src/locales/de/common.json",
          "src/locales/de/menus/main.json",
          "src/locales/pl/menus/main.json",
        ],
      );
      assertEquals(
        result.unchanged.map((f: { path: string }) => f.path),
        ["src/locales/pl/common.json"],
      );
      assertEquals(await read(dir, "src/locales/de/menus/main.json"), '{ "quit": "Beenden" }\n');

      const second = await runCli(["download"], { cwd: dir, env: ENV, fetch });
      assertEquals(second.code, 0);
      assertStringIncludes(second.stdout, "Everything is up to date (4 files).");
    },
  );
});

test("download --dry-run writes nothing", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["download", "--dry-run"], {
      cwd: dir,
      env: ENV,
      fetch: server(FILES),
    });
    assertEquals(run.code, 0);
    assertStringIncludes(run.stdout, "would create src/locales/de/common.json");
    assertStringIncludes(run.stdout, "Would write 4 files, 0 unchanged.");
    assertEquals(await exists(dir, "src/locales/de"), false);
  });
});

test("download --language and --file narrow the request", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([FILES[0]]);
    const run = await runCli(
      ["download", "--language", "de", "--file", "src/locales/en/common.json"],
      { cwd: dir, env: ENV, fetch },
    );
    assertEquals(run.code, 0, run.stderr);
    const url = new URL(fetch.requests[0].url);
    assertEquals(url.searchParams.get("languages"), "de");
    assertEquals(url.searchParams.get("files"), "common.json");
    const source = await runCli(["download", "--language", "en"], { cwd: dir, env: ENV, fetch });
    assertEquals(source.code, 2);
  });
});

test("download asks to leave untranslated strings out when the config says so", async () => {
  const omitting = { ...PROJECT, "quaso.config.json": { ...CONFIG, untranslated: "omit" } };
  await withProject(omitting, async (dir) => {
    const fetch = server(FILES);
    const run = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 0, run.stderr);
    assertEquals(new URL(fetch.requests[0].url).searchParams.get("untranslated"), "omit");
  });
  await withProject(PROJECT, async (dir) => {
    const fetch = server(FILES);
    await runCli(["download"], { cwd: dir, env: ENV, fetch });
    assertEquals(new URL(fetch.requests[0].url).searchParams.get("untranslated"), null);
  });
});

// Regression: --file with a translation path downloaded that file in every language.
test("download --file with a translation path downloads that language only", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([FILES[2]]);
    const run = await runCli(["download", "--file", "src/locales/pl/common.json", "--json"], {
      cwd: dir,
      env: ENV,
      fetch,
    });
    assertEquals(run.code, 0, run.stderr);
    const url = new URL(fetch.requests[0].url);
    assertEquals(url.searchParams.get("languages"), "pl");
    assertEquals(url.searchParams.get("files"), "common.json");
    assertEquals(
      JSON.parse(run.stdout).result.written.map((f: { path: string }) => f.path),
      ["src/locales/pl/common.json"],
    );
    const conflict = await runCli(
      ["download", "--language", "de", "--file", "src/locales/pl/common.json"],
      { cwd: dir, env: ENV, fetch },
    );
    assertEquals(conflict.code, 2);
    assertStringIncludes(conflict.stderr, "is a translation file of pl, but --language is de");
    assertEquals(fetch.requests.length, 1);
  });
});

// Regression (CLI-5): the server's language string became {lang}, so an instance could make
// the CLI write package.json or .vscode/settings.json.
test("download refuses languages and files it didn't ask for, and writes nothing", async () => {
  await withProject(
    {
      "quaso.config.json": {
        sourceLanguage: "en",
        languages: ["de"],
        files: [{ source: "en.json", translation: "{lang}.json" }],
      },
      "en.json": '{ "play": "Play" }\n',
      "package.json": '{ "name": "game" }\n',
    },
    async (dir) => {
      const run = await runCli(["download"], {
        cwd: dir,
        env: ENV,
        fetch: server([
          file("en.json", "de", '{ "play": "Spielen" }\n'),
          file("en.json", "package", '{ "scripts": { "postinstall": "echo pwned" } }\n'),
          file("en.json", ".vscode/settings", "{}\n"),
        ]),
      });
      assertEquals(run.code, 4);
      assertStringIncludes(
        run.stderr,
        "The instance sent en.json (package), which wasn't asked for.",
      );
      assertEquals(await read(dir, "package.json"), '{ "name": "game" }\n');
      assertEquals(await exists(dir, "de.json"), false, "nothing is written");
      assertEquals(await exists(dir, ".vscode"), false);
    },
  );
  await withProject(PROJECT, async (dir) => {
    const extraFile = await runCli(["download", "--file", "common.json"], {
      cwd: dir,
      env: ENV,
      fetch: server([FILES[0], FILES[1]]),
    });
    assertEquals(extraFile.code, 4);
    assertStringIncludes(extraFile.stderr, "menus/main.json (de), which wasn't asked for");
    const odd = await runCli(["download", "--language", "de"], {
      cwd: dir,
      env: ENV,
      fetch: server([FILES[0], file("common.json", "a b/c", "{}\n")]),
    });
    assertEquals(odd.code, 4);
    assertEquals(await exists(dir, "src/locales/de"), false);
    assertEquals(await exists(dir, "src/locales/a b"), false);
  });
});

// The instance's tag decides nothing: {lang} comes from the tag asked for (and its mapping).
test("download writes to the folder of the language asked for, whatever the server spells", async () => {
  await withProject(
    {
      ...PROJECT,
      "quaso.config.json": { ...CONFIG, languages: ["pt-br"], languageMapping: { "pt-BR": "pt" } },
    },
    async (dir) => {
      const run = await runCli(["download", "--json"], {
        cwd: dir,
        env: ENV,
        fetch: server([file("common.json", "PT-br", "{}\n")]),
      });
      assertEquals(run.code, 0, run.stderr);
      assertEquals(JSON.parse(run.stdout).result.written, [
        {
          path: "src/locales/pt/common.json",
          file: "common.json",
          language: "pt-BR",
          created: true,
        },
      ]);
    },
  );
});

// Regression: the instance splits the files query at commas.
test("download --file with a comma in the name asks for every file and keeps that one", async () => {
  await withProject(
    {
      ...PROJECT,
      "src/locales/en/items,weapons.json": '{ "sword": "Sword" }\n',
    },
    async (dir) => {
      const fetch = server([
        FILES[0],
        file("items,weapons.json", "de", '{ "sword": "Schwert" }\n'),
        FILES[1],
      ]);
      const run = await runCli(
        ["download", "--language", "de", "--file", "items,weapons.json", "--json"],
        { cwd: dir, env: ENV, fetch },
      );
      assertEquals(run.code, 0, run.stderr);
      assertEquals(new URL(fetch.requests[0].url).searchParams.has("files"), false);
      assertEquals(
        JSON.parse(run.stdout).result.written.map((f: { path: string }) => f.path),
        ["src/locales/de/items,weapons.json"],
      );
      assertEquals(await exists(dir, "src/locales/de/common.json"), false);
    },
  );
});

test("download never writes the source language, and writes nothing when one path is refused", async () => {
  await withProject(PROJECT, async (dir) => {
    const before = await read(dir, "src/locales/en/common.json");
    const run = await runCli(["download"], {
      cwd: dir,
      env: ENV,
      fetch: server([FILES[0], file("common.json", "en", '{ "play": "Hacked" }\n')]),
    });
    assertEquals(run.code, 4);
    assertStringIncludes(run.stderr, "common.json (en), which wasn't asked for");
    assertEquals(await read(dir, "src/locales/en/common.json"), before);
    assertEquals(await exists(dir, "src/locales/de/common.json"), false);
  });
});

// Regression: a language folder that is a file was a crash (exit code 1, "a bug in quaso").
test("download refuses a path through a file, as a usage error", async () => {
  await withProject({ ...PROJECT, "src/locales/de": "not a folder" }, async (dir) => {
    const run = await runCli(["download", "--language", "de"], {
      cwd: dir,
      env: ENV,
      fetch: server(FILES.slice(0, 2)),
    });
    assertEquals(run.code, 2, run.stderr);
    assertStringIncludes(run.stderr, "src/locales/de is a file, not a folder");
    assertEquals(run.stderr.includes("a bug in quaso"), false);
    assertEquals(await read(dir, "src/locales/de"), "not a folder");
  });
});

// Regression (CLI-5): a translation pattern inside the source glob wrote German files that
// the next upload sent as English.
test("download refuses to write where a source glob would find the file", async () => {
  await withProject(
    {
      "quaso.config.json": {
        ...CONFIG,
        languages: ["de"],
        files: [
          { source: "a/en/*.json", translation: "b/{lang}/{path}" },
          // No such file yet, but the next upload would find the German one here.
          { source: "b/de/special.json", translation: "c/{lang}.json" },
        ],
      },
      "a/en/common.json": '{ "play": "Play" }\n',
      "a/en/special.json": '{ "boss": "Boss" }\n',
    },
    async (dir) => {
      const run = await runCli(["download"], {
        cwd: dir,
        env: ENV,
        fetch: server([
          file("common.json", "de", '{ "play": "Spielen" }\n'),
          file("special.json", "de", '{ "boss": "Boss" }\n'),
        ]),
      });
      assertEquals(run.code, 2, run.stderr);
      assertStringIncludes(run.stderr, "Refusing to write b/de/special.json (de): files[1].source");
      assertEquals(await exists(dir, "b"), false, "nothing is written");
    },
  );
});

test("download refuses linked folders that lead outside or onto the source files", async () => {
  if (process.platform === "win32") return;
  await withProject(PROJECT, async (dir) => {
    await withProject({ "x.json": "{}" }, async (outside) => {
      await fs.mkdir(join(dir, "src", "locales"), { recursive: true });
      await fs.symlink(outside, join(dir, "src", "locales", "de"));
      const run = await runCli(["download", "--language", "de"], {
        cwd: dir,
        env: ENV,
        fetch: server(FILES.slice(0, 2)),
      });
      assertEquals(run.code, 2);
      assertStringIncludes(run.stderr, "a linked folder leads outside the project folder");
      assertEquals(await exists(outside, "common.json"), false);
    });
    await fs.rm(join(dir, "src", "locales", "de"));
    await fs.symlink(join(dir, "src", "locales", "en"), join(dir, "src", "locales", "de"));
    const before = await read(dir, "src/locales/en/common.json");
    const run = await runCli(["download", "--language", "de"], {
      cwd: dir,
      env: ENV,
      fetch: server(FILES.slice(0, 2)),
    });
    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "a linked folder makes it a source file");
    assertEquals(await read(dir, "src/locales/en/common.json"), before);
  });
});

test("download: a damaged file is exit code 4 and nothing is written", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["download"], {
      cwd: dir,
      env: ENV,
      fetch: server([FILES[0], file("common.json", "pl", "{}\n", "0".repeat(64))]),
    });
    assertEquals(run.code, 4);
    assertEquals(await exists(dir, "src/locales/de/common.json"), false);
  });
});

test("download skips files that no local source file maps to", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["download", "--json"], {
      cwd: dir,
      env: ENV,
      fetch: server([file("../../../escape.json", "de", "{}"), file("gone.json", "de", "{}")]),
    });
    assertEquals(run.code, 0);
    assertEquals(
      JSON.parse(run.stdout).result.skipped.map((s: { file: string }) => s.file),
      ["../../../escape.json", "gone.json"],
    );
    assertEquals(await exists(dir, "src/locales/de"), false);
  });
});

test("download: a pattern without {path} can't take several files", async () => {
  await withProject(
    {
      ...PROJECT,
      "quaso.config.json": {
        ...CONFIG,
        files: [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}.json" }],
      },
    },
    async (dir) => {
      const run = await runCli(["download"], { cwd: dir, env: ENV, fetch: server(FILES) });
      assertEquals(run.code, 2);
      assertStringIncludes(run.stderr, "would both be written to src/locales/de.json");
    },
  );
});

test("download --prune deletes only translation files whose source is gone", async () => {
  await withProject(
    {
      ...PROJECT,
      "src/locales/de/old.json": "{}",
      "src/locales/de/menus/old.json": "{}",
      "src/locales/de/notes.txt": "keep",
      "src/locales/de/common.json": '{ "play": "Spielen" }\n',
      "src/locales/fr/old.json": "{}",
      "src/locales/pl/.hidden/old.json": "{}",
    },
    async (dir) => {
      const fetch = server(FILES);
      const dry = await runCli(["download", "--prune", "--dry-run", "--json"], {
        cwd: dir,
        env: ENV,
        fetch,
      });
      assertEquals(dry.code, 0, dry.stderr);
      assertEquals(JSON.parse(dry.stdout).result.pruned, [
        { path: "src/locales/de/menus/old.json", language: "de" },
        { path: "src/locales/de/old.json", language: "de" },
      ]);
      assert(await exists(dir, "src/locales/de/old.json"));
      const run = await runCli(["download", "--prune"], { cwd: dir, env: ENV, fetch });
      assertEquals(run.code, 0);
      assertStringIncludes(run.stdout, "deleted      src/locales/de/old.json");
      assertEquals(await exists(dir, "src/locales/de/old.json"), false);
      assertEquals(await exists(dir, "src/locales/de/menus/old.json"), false);
      assert(await exists(dir, "src/locales/de/notes.txt"), "not a file the pattern writes");
      assert(await exists(dir, "src/locales/fr/old.json"), "fr isn't a configured language");
      assert(await exists(dir, "src/locales/pl/.hidden/old.json"), "dot folders are left alone");
      assert(await exists(dir, "src/locales/en/common.json"));
      const withFile = await runCli(["download", "--prune", "--file", "common.json"], {
        cwd: dir,
        env: ENV,
        fetch,
      });
      assertEquals(withFile.code, 2);
    },
  );
});

test("download --prune only deletes what the source glob could have matched", async () => {
  await withProject(
    {
      "quaso.config.json": {
        ...CONFIG,
        files: [
          {
            source: "i18n/en/*.json",
            translation: "i18n/{lang}/{path}",
            exclude: ["i18n/en/skip.json"],
          },
        ],
      },
      "i18n/en/common.json": "{}",
      "i18n/de/common.json": "{}",
      "i18n/de/old.json": "{}",
      "i18n/de/nested/old.json": "{}",
      "i18n/de/skip.json": "{}",
    },
    async (dir) => {
      const fetch = server([file("common.json", "de", "{}")]);
      const run = await runCli(["download", "--prune", "--language", "de", "--json"], {
        cwd: dir,
        env: ENV,
        fetch,
      });
      assertEquals(run.code, 0, run.stderr);
      assertEquals(JSON.parse(run.stdout).result.pruned, [
        {
          path: "i18n/de/old.json",
          language: "de",
        },
      ]);
      assert(await exists(dir, "i18n/de/nested/old.json"), "*.json doesn't match nested files");
      assert(await exists(dir, "i18n/de/skip.json"), "excluded sources are never pruned");
    },
  );
});
