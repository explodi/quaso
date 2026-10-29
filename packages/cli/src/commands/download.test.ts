// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
import { join } from "node:path";
import { type ExportFile, type ExportResult, sha256Hex } from "@quaso/core";
import { CONFIG, fakeFetch, jsonResponse, runCli, withProject } from "../test_helpers.ts";

const ENV = { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: "qso_key" };

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

test("download reports outdated keys in normal, dry-run and JSON output", async () => {
  const old = { ...FILES[0], outdated: [{ key: "play", sourceRevision: 1035 }] };
  await withProject(PROJECT, async (dir) => {
    const fetch = server([old]);
    const dry = await runCli(["download", "--dry-run"], { cwd: dir, env: ENV, fetch });
    expect(dry.stdout).toContain("outdated     de  common.json › play");
    expect(dry.stderr).toContain("older source");
    expect(await exists(dir, "src/locales/de/common.json")).toBe(false);
    const json = await runCli(["download", "--json"], { cwd: dir, env: ENV, fetch });
    expect(JSON.parse(json.stdout).result.outdated).toStrictEqual([
      { file: "common.json", language: "de", key: "play", sourceRevision: 1035 },
    ]);
    const unchanged = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    expect(unchanged.stdout).toContain("Source file changed in revision 1035");
    expect(unchanged.stderr).toContain("quaso translate");
  });
});

test("download passes the independent outdated omission policy", async () => {
  await withProject(
    { ...PROJECT, "quaso.config.json": { ...CONFIG, outdated: "omit" } },
    async (dir) => {
      const fetch = server(FILES);
      const result = await runCli(["download"], { cwd: dir, env: ENV, fetch });
      expect(result.code, result.stderr).toBe(0);
      expect(new URL(fetch.requests[0].url).searchParams.get("outdated")).toBe("omit");
    },
  );
});

test("download writes changed files only, creating folders", async () => {
  await withProject(
    { ...PROJECT, "src/locales/pl/common.json": '{ "play": "Graj" }\n' },
    async (dir) => {
      const fetch = server(FILES);
      const first = await runCli(["download", "--json"], { cwd: dir, env: ENV, fetch });
      expect(first.code, first.stderr).toBe(0);
      expect(new URL(fetch.requests[0].url).searchParams.get("languages")).toBe("de,pl");
      const result = JSON.parse(first.stdout).result;
      expect(result.written.map((f: { path: string }) => f.path)).toStrictEqual([
        "src/locales/de/common.json",
        "src/locales/de/menus/main.json",
        "src/locales/pl/menus/main.json",
      ]);
      expect(result.unchanged.map((f: { path: string }) => f.path)).toStrictEqual([
        "src/locales/pl/common.json",
      ]);
      expect(await read(dir, "src/locales/de/menus/main.json")).toStrictEqual(
        '{ "quit": "Beenden" }\n',
      );

      const second = await runCli(["download"], { cwd: dir, env: ENV, fetch });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("Everything is up to date (4 files).");
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
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("would create src/locales/de/common.json");
    expect(run.stdout).toContain("Would write 4 files, 0 unchanged.");
    expect(await exists(dir, "src/locales/de")).toBe(false);
  });
});

test("download --language and --file narrow the request", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([FILES[0]]);
    const run = await runCli(
      ["download", "--language", "de", "--file", "src/locales/en/common.json"],
      { cwd: dir, env: ENV, fetch },
    );
    expect(run.code, run.stderr).toBe(0);
    const url = new URL(fetch.requests[0].url);
    expect(url.searchParams.get("languages")).toBe("de");
    expect(url.searchParams.get("files")).toBe("common.json");
    const source = await runCli(["download", "--language", "en"], { cwd: dir, env: ENV, fetch });
    expect(source.code).toBe(2);
  });
});

test("download asks to leave untranslated strings out when the config says so", async () => {
  const omitting = { ...PROJECT, "quaso.config.json": { ...CONFIG, untranslated: "omit" } };
  await withProject(omitting, async (dir) => {
    const fetch = server(FILES);
    const run = await runCli(["download"], { cwd: dir, env: ENV, fetch });
    expect(run.code, run.stderr).toBe(0);
    expect(new URL(fetch.requests[0].url).searchParams.get("untranslated")).toBe("omit");
  });
  await withProject(PROJECT, async (dir) => {
    const fetch = server(FILES);
    await runCli(["download"], { cwd: dir, env: ENV, fetch });
    expect(new URL(fetch.requests[0].url).searchParams.get("untranslated")).toBe(null);
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
    expect(run.code, run.stderr).toBe(0);
    const url = new URL(fetch.requests[0].url);
    expect(url.searchParams.get("languages")).toBe("pl");
    expect(url.searchParams.get("files")).toBe("common.json");
    expect(
      JSON.parse(run.stdout).result.written.map((f: { path: string }) => f.path),
    ).toStrictEqual(["src/locales/pl/common.json"]);
    const conflict = await runCli(
      ["download", "--language", "de", "--file", "src/locales/pl/common.json"],
      { cwd: dir, env: ENV, fetch },
    );
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("is a translation file of pl, but --language is de");
    expect(fetch.requests.length).toBe(1);
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
      expect(run.code).toBe(4);
      expect(run.stderr).toContain("The instance sent en.json (package), which wasn't asked for.");
      expect(await read(dir, "package.json")).toBe('{ "name": "game" }\n');
      expect(await exists(dir, "de.json"), "nothing is written").toBe(false);
      expect(await exists(dir, ".vscode")).toBe(false);
    },
  );
  await withProject(PROJECT, async (dir) => {
    const extraFile = await runCli(["download", "--file", "common.json"], {
      cwd: dir,
      env: ENV,
      fetch: server([FILES[0], FILES[1]]),
    });
    expect(extraFile.code).toBe(4);
    expect(extraFile.stderr).toContain("menus/main.json (de), which wasn't asked for");
    const odd = await runCli(["download", "--language", "de"], {
      cwd: dir,
      env: ENV,
      fetch: server([FILES[0], file("common.json", "a b/c", "{}\n")]),
    });
    expect(odd.code).toBe(4);
    expect(await exists(dir, "src/locales/de")).toBe(false);
    expect(await exists(dir, "src/locales/a b")).toBe(false);
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
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).result.written).toStrictEqual([
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
      expect(run.code, run.stderr).toBe(0);
      expect(new URL(fetch.requests[0].url).searchParams.has("files")).toBe(false);
      expect(
        JSON.parse(run.stdout).result.written.map((f: { path: string }) => f.path),
      ).toStrictEqual(["src/locales/de/items,weapons.json"]);
      expect(await exists(dir, "src/locales/de/common.json")).toBe(false);
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
    expect(run.code).toBe(4);
    expect(run.stderr).toContain("common.json (en), which wasn't asked for");
    expect(await read(dir, "src/locales/en/common.json")).toStrictEqual(before);
    expect(await exists(dir, "src/locales/de/common.json")).toBe(false);
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
    expect(run.code, run.stderr).toBe(2);
    expect(run.stderr).toContain("src/locales/de is a file, not a folder");
    expect(run.stderr.includes("a bug in quaso")).toBe(false);
    expect(await read(dir, "src/locales/de")).toBe("not a folder");
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
      expect(run.code, run.stderr).toBe(2);
      expect(run.stderr).toContain("Refusing to write b/de/special.json (de): files[1].source");
      expect(await exists(dir, "b"), "nothing is written").toBe(false);
    },
  );
});

test("download refuses a linked folder that leads outside", async () => {
  if (process.platform === "win32") return;
  await withProject(PROJECT, async (dir) => {
    await withProject({ "x.json": "{}" }, async (outside) => {
      await fs.symlink(outside, join(dir, "src", "locales", "de"));
      const run = await runCli(["download", "--language", "de"], {
        cwd: dir,
        env: ENV,
        fetch: server(FILES.slice(0, 2)),
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("src/locales/de is a symbolic link");
      expect(await exists(outside, "common.json")).toBe(false);
    });
  });
});

// Regression (audit QUASO-F2): a committed link let the instance write a git hook.
test(
  "download refuses to write through a translation file that is a link inside the project",
  { skip: process.platform === "win32" },
  async () => {
    await withProject(
      {
        ...PROJECT,
        ".git/hooks/pre-commit": "#!/bin/sh\n",
        "src/locales/de/menus/main.json": "{}",
      },
      async (dir) => {
        await fs.symlink(
          join("..", "..", "..", ".git", "hooks", "pre-commit"),
          join(dir, "src", "locales", "de", "common.json"),
        );
        const run = await runCli(["download", "--language", "de", "--overwrite-local"], {
          cwd: dir,
          env: ENV,
          fetch: server(FILES.slice(0, 2)),
        });
        expect(run.code).toBe(2);
        expect(run.stderr).toContain(
          "Refusing to write src/locales/de/common.json (de): " +
            "src/locales/de/common.json is a symbolic link",
        );
        expect(await read(dir, ".git/hooks/pre-commit")).toBe("#!/bin/sh\n");
      },
    );
  },
);

test(
  "download refuses to write through a linked folder inside the project",
  { skip: process.platform === "win32" },
  async () => {
    await withProject({ ...PROJECT, ".git/hooks/README": "" }, async (dir) => {
      await fs.symlink(join("..", "..", ".git", "hooks"), join(dir, "src", "locales", "de"));
      const run = await runCli(["download", "--language", "de"], {
        cwd: dir,
        env: ENV,
        fetch: server(FILES.slice(0, 2)),
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("src/locales/de is a symbolic link");
      expect(await exists(dir, ".git/hooks/common.json")).toBe(false);
    });
  },
);

test(
  "download refuses to write a source file that a linked source folder leads to",
  { skip: process.platform === "win32" },
  async () => {
    await withProject(
      { "quaso.config.json": CONFIG, "src/locales/de/common.json": '{ "play": "Play" }\n' },
      async (dir) => {
        await fs.symlink(join(dir, "src", "locales", "de"), join(dir, "src", "locales", "en"));
        const run = await runCli(["download", "--language", "de", "--overwrite-local"], {
          cwd: dir,
          env: ENV,
          fetch: server(FILES.slice(0, 1)),
        });
        expect(run.code).toBe(2);
        expect(run.stderr).toContain("a linked folder makes it a source file");
        expect(await read(dir, "src/locales/de/common.json")).toBe('{ "play": "Play" }\n');
      },
    );
  },
);

test("download: a damaged file is exit code 4 and nothing is written", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["download"], {
      cwd: dir,
      env: ENV,
      fetch: server([FILES[0], file("common.json", "pl", "{}\n", "0".repeat(64))]),
    });
    expect(run.code).toBe(4);
    expect(await exists(dir, "src/locales/de/common.json")).toBe(false);
  });
});

test("download skips files that no local source file maps to", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["download", "--json"], {
      cwd: dir,
      env: ENV,
      fetch: server([file("../../../escape.json", "de", "{}"), file("gone.json", "de", "{}")]),
    });
    expect(run.code).toBe(0);
    expect(
      JSON.parse(run.stdout).result.skipped.map((s: { file: string }) => s.file),
    ).toStrictEqual(["../../../escape.json", "gone.json"]);
    expect(await exists(dir, "src/locales/de")).toBe(false);
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
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("would both be written to src/locales/de.json");
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
      expect(dry.code, dry.stderr).toBe(0);
      expect(JSON.parse(dry.stdout).result.pruned).toStrictEqual([
        { path: "src/locales/de/menus/old.json", language: "de" },
        { path: "src/locales/de/old.json", language: "de" },
      ]);
      assert(await exists(dir, "src/locales/de/old.json"));
      const run = await runCli(["download", "--prune"], { cwd: dir, env: ENV, fetch });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("deleted      src/locales/de/old.json");
      expect(await exists(dir, "src/locales/de/old.json")).toBe(false);
      expect(await exists(dir, "src/locales/de/menus/old.json")).toBe(false);
      assert(await exists(dir, "src/locales/de/notes.txt"), "not a file the pattern writes");
      assert(await exists(dir, "src/locales/fr/old.json"), "fr isn't a configured language");
      assert(await exists(dir, "src/locales/pl/.hidden/old.json"), "dot folders are left alone");
      assert(await exists(dir, "src/locales/en/common.json"));
      const withFile = await runCli(["download", "--prune", "--file", "common.json"], {
        cwd: dir,
        env: ENV,
        fetch,
      });
      expect(withFile.code).toBe(2);
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
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).result.pruned).toStrictEqual([
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

test("download preserves hand edits, reports conflicts in dry-run/JSON, and requires an explicit overwrite", async () => {
  await withProject(PROJECT, async (dir) => {
    await runCli(["download"], { cwd: dir, env: ENV, fetch: server([FILES[0]]) });
    const manual = '{ "play": "Los" }\n';
    await fs.writeFile(join(dir, "src/locales/de/common.json"), manual);
    const changed = server([file("common.json", "de", '{ "play": "Spiele" }\n')]);
    const baseline = await read(dir, ".quaso/download-state");
    const dry = await runCli(["download", "--dry-run"], { cwd: dir, env: ENV, fetch: changed });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("local edit   de  common.json › play");
    expect(await read(dir, ".quaso/download-state")).toStrictEqual(baseline);
    const refused = await runCli(["download", "--json"], { cwd: dir, env: ENV, fetch: changed });
    expect(refused.code).toBe(6);
    expect(JSON.parse(refused.stdout).result.localEdits[0].key).toBe("play");
    expect(await read(dir, "src/locales/de/common.json")).toStrictEqual(manual);
    const overwritten = await runCli(["download", "--overwrite-local"], {
      cwd: dir,
      env: ENV,
      fetch: changed,
    });
    expect(overwritten.code).toBe(0);
    expect(await read(dir, "src/locales/de/common.json")).toBe('{ "play": "Spiele" }\n');
  });
});

test("download accepts server updates and identical local fixes but preserves unknown first-download values", async () => {
  await withProject(
    { ...PROJECT, "src/locales/de/common.json": '{"play":"Human wording"}' },
    async (dir) => {
      const refused = await runCli(["download"], { cwd: dir, env: ENV, fetch: server([FILES[0]]) });
      expect(refused.code).toBe(6);
      expect(refused.stderr).toContain("quaso import --as blue");
      await runCli(["download", "--overwrite-local"], {
        cwd: dir,
        env: ENV,
        fetch: server([FILES[0]]),
      });
      const update = file("common.json", "de", '{"play":"Spiele"}\n');
      const updated = await runCli(["download"], { cwd: dir, env: ENV, fetch: server([update]) });
      expect(updated.code).toBe(0);
      await fs.writeFile(join(dir, "src/locales/de/common.json"), '{"play":"Los"}\n');
      const identical = await runCli(["download"], {
        cwd: dir,
        env: ENV,
        fetch: server([file("common.json", "de", '{"play":"Los"}\n')]),
      });
      expect(identical.code).toBe(0);
    },
  );
});

test("download refuses a baseline folder linked outside the project before writing files", async () => {
  await withProject(PROJECT, async (dir) => {
    const outside = await fs.mkdtemp(join(dir, "../quaso-state-outside-"));
    try {
      await fs.symlink(outside, join(dir, ".quaso"), "dir");
      const refused = await runCli(["download"], { cwd: dir, env: ENV, fetch: server([FILES[0]]) });
      expect(refused.code).toBe(2);
      expect(await exists(dir, "src/locales/de/common.json")).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
