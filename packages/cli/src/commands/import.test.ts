// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { join, relative } from "node:path";
import type { ImportRequest, ImportResult } from "@quaso/core";
import { CONFIG, fakeFetch, jsonResponse, runCli, withProject } from "../test_helpers.ts";

const ENV = { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: "qso_key" };

const PROJECT = {
  "quaso.config.json": CONFIG,
  "src/locales/en/common.json": '{ "total": "{{count}} of {{total}}" }\n',
  "src/locales/en/menus.json": '{ "quit": "Quit" }\n',
  "src/locales/de/common.json": '{ "total": "{{count}} von" }\n',
  "src/locales/de/menus.json": '{ "quit": "Beenden", "old": "Alt" }\n',
};

/** An instance with these languages, answering imports with `answer`. */
function instance(
  answer: (request: ImportRequest, index: number) => Response | ImportResult,
  languages = ["de", "pl"],
) {
  let imports = 0;
  const fetch = fakeFetch(async (request) => {
    if (new URL(request.url).pathname === "/api/v1/project") {
      return jsonResponse({ languages: languages.map((tag) => ({ tag })) });
    }
    const answered = answer(await request.clone().json(), imports++);
    return answered instanceof Response ? answered : jsonResponse(answered);
  });
  return Object.assign(fetch, {
    imports: () => fetch.requests.filter((request) => request.method === "POST"),
  });
}

function result(request: ImportRequest, overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    dryRun: request.dryRun === true,
    language: request.language,
    imported: request.files.length,
    unchanged: 0,
    skippedIdentical: 0,
    skippedEmpty: 0,
    droppedForms: 0,
    skippedBlue: 0,
    refused: [],
    flagged: [],
    unknownKeys: [],
    unknownFiles: [],
    ...overrides,
  };
}

test("import needs --as", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["import"], {
      cwd: dir,
      env: ENV,
      fetch: fakeFetch(() => jsonResponse({})),
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--as is required");
  });
});

test("import --from reads a separate nested export without changing either folder", async () => {
  await withProject(PROJECT, async (dir) => {
    await withProject(
      { "src/locales/de/menus.json": '{ "quit": "Approved" }\n' },
      async (exportDir) => {
        const path = join(exportDir, "src/locales/de/menus.json");
        const before = await fs.stat(path);
        const fetch = instance((request) => result(request));
        const run = await runCli(
          ["import", "--as", "blue", "--from", relative(dir, exportDir), "--json"],
          {
            cwd: dir,
            env: ENV,
            fetch,
          },
        );
        expect(run.code, run.stderr).toBe(0);
        expect(await fetch.imports()[0].json()).toStrictEqual({
          language: "de",
          as: "blue",
          files: [{ path: "menus.json", content: '{ "quit": "Approved" }\n' }],
        });
        expect(JSON.parse(run.stdout).result.languages[0].files).toStrictEqual([
          { file: "menus.json", path },
        ]);
        expect(await fs.readFile(path, "utf8")).toBe('{ "quit": "Approved" }\n');
        expect((await fs.stat(path)).mtimeMs).toStrictEqual(before.mtimeMs);
        expect(await fs.readFile(join(dir, "src/locales/de/menus.json"), "utf8")).toStrictEqual(
          PROJECT["src/locales/de/menus.json"],
        );
        expect(await fs.readdir(exportDir)).toStrictEqual(["src"]);
      },
    );
  });
});

test("import --from requires an existing directory before sending requests", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = instance((request) => result(request));
    const missing = await runCli(["import", "--as", "green", "--from", "missing"], {
      cwd: dir,
      env: ENV,
      fetch,
    });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--from missing");
    const file = await runCli(["import", "--as", "green", "--from", "quaso.config.json"], {
      cwd: dir,
      env: ENV,
      fetch,
    });
    expect(file.code).toBe(2);
    expect(file.stderr).toContain("not a folder");
    expect(fetch.requests.length).toBe(0);
  });
});

test("import --from refuses symlinks in the export before sending requests", async () => {
  await withProject(PROJECT, async (dir) => {
    await withProject({ "src/locales/de/menus.json": "{}" }, async (exportDir) => {
      const path = join(exportDir, "src/locales/de/menus.json");
      await fs.unlink(path);
      await fs.symlink(join(dir, "src/locales/de/menus.json"), path);
      const fetch = instance((request) => result(request));
      const run = await runCli(["import", "--as", "blue", "--from", exportDir], {
        cwd: dir,
        env: ENV,
        fetch,
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("src/locales/de/menus.json is a symbolic link");
      expect(fetch.requests.length).toBe(0);
    });
  });
});

test("import sends each language's existing files, with the options", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = instance((request) => result(request));
    const run = await runCli(
      ["import", "--as", "blue", "--overwrite", "--keep-identical", "--dry-run"],
      { cwd: dir, env: ENV, fetch },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(fetch.imports().length, "pl has no files, so only de is sent").toBe(1);
    const body: ImportRequest = await fetch.imports()[0].json();
    expect(body).toStrictEqual({
      language: "de",
      files: [
        { path: "common.json", content: '{ "total": "{{count}} von" }\n' },
        { path: "menus.json", content: '{ "quit": "Beenden", "old": "Alt" }\n' },
      ],
      as: "blue",
      overwrite: true,
      keepIdentical: true,
      dryRun: true,
    });
    expect(run.stdout).toContain("Dry run: nothing was saved.");
    expect(run.stdout).toContain("de     2 to import as blue");
    expect(run.stdout).toContain("No translation files for pl.");
  });
});

test("import lists refused values with local paths and exits with code 6", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = instance((request) =>
      result(request, {
        imported: 1,
        refused: [
          {
            file: "common.json",
            key: "total",
            language: "de",
            checks: [
              {
                check: "placeholder_missing",
                severity: "error",
                message: "Placeholder {{total}} is missing.",
                value: "{{total}}",
              },
              { check: "numbers_differ", severity: "warning", message: "The numbers differ." },
            ],
          },
        ],
        unknownKeys: [{ file: "menus.json", key: "old" }],
      }),
    );
    const run = await runCli(["import", "--as", "green", "--language", "de"], {
      cwd: dir,
      env: ENV,
      fetch,
    });
    expect(run.code).toBe(6);
    expect(run.stdout).toContain(
      "src/locales/de/common.json › total (de): placeholder {{total}} is missing",
    );
    expect(run.stdout.includes("numbers differ"), "only the checks that refused it").toStrictEqual(
      false,
    );
    expect(run.stdout).toContain("src/locales/de/menus.json › old (de): not in the English");
    const json = await runCli(["import", "--as", "green", "--json"], { cwd: dir, env: ENV, fetch });
    const document = JSON.parse(json.stdout);
    expect(document.exitCode).toBe(6);
    expect(document.result.refused).toStrictEqual([
      {
        file: "src/locales/de/common.json",
        key: "total",
        language: "de",
        check: "placeholder_missing",
        message: "Placeholder {{total}} is missing.",
      },
    ]);
  });
});

test("import: a translation file with a syntax error is exit code 5, named locally", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = instance(() =>
      jsonResponse(
        {
          error: {
            code: "invalid_source",
            message: "menus.json:1:40: Expected a property name",
            details: [
              {
                file: "menus.json",
                line: 1,
                column: 40,
                message: "Expected a property name",
              },
            ],
          },
        },
        422,
      ),
    );
    const run = await runCli(["import", "--as", "green"], { cwd: dir, env: ENV, fetch });
    expect(run.code).toBe(5);
    expect(run.stdout).toContain("src/locales/de/menus.json:1:40 (de): expected a property name");
  });
});

test("import --file takes translation paths too", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = instance((request) => result(request));
    const run = await runCli(["import", "--as", "green", "--file", "src/locales/de/menus.json"], {
      cwd: dir,
      env: ENV,
      fetch,
    });
    expect(run.code, run.stderr).toBe(0);
    const body: ImportRequest = await fetch.imports()[0].json();
    expect(body.files.map((file) => file.path)).toStrictEqual(["menus.json"]);
  });
});

// Regression: a translation path chose the source file, which was then imported in every
// language, overwriting newer translations with stale local files.
test("import --file with a translation path imports that language only", async () => {
  await withProject(
    {
      ...PROJECT,
      "quaso.config.json": { ...CONFIG, languages: ["de", "fr"] },
      "src/locales/de/common.json": '{ "total": "Spielen (alt)" }\n',
      "src/locales/fr/common.json": '{ "total": "{{count}} sur {{total}}" }\n',
    },
    async (dir) => {
      const fetch = instance((request) => result(request), ["de", "fr"]);
      const run = await runCli(
        ["import", "--as", "green", "--file", "src/locales/fr/common.json", "--json"],
        { cwd: dir, env: ENV, fetch },
      );
      expect(run.code, run.stderr).toBe(0);
      const bodies: ImportRequest[] = await Promise.all(fetch.imports().map((r) => r.json()));
      expect(bodies.map((body) => [body.language, body.files.map((f) => f.path)])).toStrictEqual([
        ["fr", ["common.json"]],
      ]);
      const conflict = await runCli(
        ["import", "--as", "green", "--language", "de", "--file", "src/locales/fr/common.json"],
        { cwd: dir, env: ENV, fetch },
      );
      expect(conflict.code).toBe(2);
      expect(fetch.imports().length).toBe(1);
    },
  );
});

// Regression: a language the instance lacks stopped the import halfway, with exit code 2
// and no word of the languages already imported.
test("import checks the instance's languages before importing any", async () => {
  await withProject(
    {
      ...PROJECT,
      "quaso.config.json": { ...CONFIG, languages: ["de", "ko"] },
      "src/locales/ko/common.json": '{ "total": "{{count}} / {{total}}" }\n',
    },
    async (dir) => {
      const fetch = instance((request) => result(request), ["de"]);
      const run = await runCli(["import", "--as", "green", "--json"], {
        cwd: dir,
        env: ENV,
        fetch,
      });
      expect(run.code).toBe(2);
      expect(fetch.imports().length, "nothing is imported").toBe(0);
      const document = JSON.parse(run.stdout);
      expect(document.error.code).toBe("unknown_language");
      expect(document.error.message).toStrictEqual(
        "The instance has no language ko, so nothing was imported.",
      );
      expect(document.error.hint).toContain("quaso upload adds the languages");
    },
  );
});

test("import: when a language fails after others were imported, the summary says so", async () => {
  await withProject(
    {
      ...PROJECT,
      "quaso.config.json": { ...CONFIG, languages: ["de", "fr", "pl"] },
      "src/locales/fr/common.json": '{ "total": "{{count}} sur {{total}}" }\n',
      "src/locales/pl/common.json": '{ "total": "{{count}} z {{total}}" }\n',
    },
    async (dir) => {
      const failing = () =>
        instance(
          (request, index) =>
            index === 1
              ? jsonResponse({ error: { code: "bad_request", message: "Not today." } }, 400)
              : result(request),
          ["de", "fr", "pl"],
        );
      const run = await runCli(["import", "--as", "green", "--json"], {
        cwd: dir,
        env: ENV,
        fetch: failing(),
      });
      expect(run.code, run.stderr).toBe(6);
      const document = JSON.parse(run.stdout);
      expect(document.exitCode).toBe(6);
      expect(document.result.languages.map((l: { language: string }) => l.language)).toStrictEqual([
        "de",
        "pl",
      ]);
      expect(document.result.failed).toStrictEqual([
        {
          language: "fr",
          code: "bad_request",
          message: "Not today.",
          exitCode: 2,
        },
      ]);
      const text = await runCli(["import", "--as", "green"], {
        cwd: dir,
        env: ENV,
        fetch: failing(),
      });
      expect(text.stdout).toContain("Languages not imported (1):");
      expect(text.stdout).toContain("  fr: not today");

      // A failure on the first language is the command's error: nothing was imported.
      const first = instance(
        () => jsonResponse({ error: { code: "forbidden", message: "No scope." } }, 403),
        ["de", "fr", "pl"],
      );
      const failed = await runCli(["import", "--as", "green"], {
        cwd: dir,
        env: ENV,
        fetch: first,
      });
      expect(failed.code).toBe(3);
      expect(first.imports().length).toBe(1);
    },
  );
});

// Regression (CLI-5): a symbolic link sent a file from outside the project to the instance.
test("import refuses to read through a link that leads outside the project", async () => {
  if (process.platform === "win32") return;
  await withProject({ "common.json": '{ "total": "OUTSIDE-SECRET" }' }, async (outside) => {
    await withProject(
      {
        "quaso.config.json": CONFIG,
        "src/locales/en/common.json": '{ "total": "{{count}} of {{total}}" }\n',
      },
      async (dir) => {
        await fs.symlink(outside, join(dir, "src", "locales", "de"));
        const fetch = instance((request) => result(request));
        const run = await runCli(["import", "--as", "green", "--language", "de"], {
          cwd: dir,
          env: ENV,
          fetch,
        });
        expect(run.code).toBe(2);
        expect(run.stderr).toContain(
          "Refusing to read src/locales/de/common.json: src/locales/de is a symbolic link",
        );
        expect(fetch.requests.length).toBe(0);
      },
    );
  });
});
