// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { runCli, withProject } from "../test_helpers.ts";
import { defaultTranslation } from "./init.ts";
import { loadProject } from "../config.ts";
import { collectSources, translationPath } from "../files.ts";

test("init language mappings preserve nested translation destinations", async () => {
  await withProject({ "src/locales/en/menu/play.json": "{}" }, async (dir) => {
    const run = await runCli(
      [
        "init",
        "--languages",
        "zh-Hans,pt-PT",
        "--language-mapping",
        "zh-Hans=zh",
        "--language-mapping",
        "pt-PT=pt",
        "--json",
      ],
      { cwd: dir },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).result.config.languageMapping).toStrictEqual({
      "zh-Hans": "zh",
      "pt-PT": "pt",
    });
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    expect(translationPath(project, sources.files[0], "zh-Hans")).toStrictEqual(
      "src/locales/zh/menu/play.json",
    );
    expect(translationPath(project, sources.files[0], "pt-PT")).toStrictEqual(
      "src/locales/pt/menu/play.json",
    );
  });
});

test("init refuses conflicting language mappings before writing", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(
      ["init", "--languages", "pt-PT", "--language-mapping", "pt-PT=pt,pt-pt=portuguese"],
      { cwd: dir },
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("more than one folder");
    expect(await fs.readdir(dir)).toStrictEqual([]);
  });
});

test("init refuses a mapped language outside its targets", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(["init", "--languages", "de", "--language-mapping", "zh-Hans=zh"], {
      cwd: dir,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("not one of --languages");
    expect(await fs.readdir(dir)).toStrictEqual([]);
  });
});

test("init refuses unsafe language folder names", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(["init", "--languages", "de", "--language-mapping", "de=../outside"], {
      cwd: dir,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("can't be a folder or file name");
    expect(await fs.readdir(dir)).toStrictEqual([]);
  });
});

test("init refuses malformed mapping entries", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(["init", "--languages", "de", "--language-mapping", "de"], {
      cwd: dir,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("must be a language tag followed by =folder");
    expect(await fs.readdir(dir)).toStrictEqual([]);
  });
});

test("defaultTranslation replaces the source language's folder or file name", () => {
  expect(defaultTranslation("src/locales/en/**/*.json", "en")).toStrictEqual(
    "src/locales/{lang}/{path}",
  );
  expect(defaultTranslation("public/locales/en/*.json", "en")).toStrictEqual(
    "public/locales/{lang}/{path}",
  );
  expect(defaultTranslation("locales/en/app/*.json", "en")).toStrictEqual(
    "locales/{lang}/app/{path}",
  );
  expect(defaultTranslation("locales/en.json", "en")).toBe("locales/{lang}.json");
  expect(defaultTranslation("i18n/*.json", "en")).toBe(null);
});

test("init writes a starter config and never overwrites one", async () => {
  await withProject({ "src/locales/en/common.json": "{}" }, async (dir) => {
    const run = await runCli(["init", "--languages", "de,fr", "--languages", "pt-BR"], {
      cwd: dir,
      env: { QUASO_HOSTNAME: "translate.game.test" },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("src/locales/en/**/*.json (1 file found)");
    const config = JSON.parse(await fs.readFile(join(dir, "quaso.config.json"), "utf8"));
    expect(config).toStrictEqual({
      $schema: "https://translate.game.test/schema/config-v1.json",
      sourceLanguage: "en",
      languages: ["de", "fr", "pt-BR"],
      files: [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
    });
    const again = await runCli(["init", "--languages", "ja"], { cwd: dir });
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("init never overwrites it");
    expect(JSON.parse(await fs.readFile(join(dir, "quaso.config.json"), "utf8"))).toStrictEqual(
      config,
    );
  });
});

test("init takes --source, --files and --translation, without $schema when no hostname", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(
      ["init", "--json", "--source", "de", "--languages", "en", "--files", "i18n/{source}.json"],
      { cwd: dir },
    );
    expect(run.code, run.stderr).toBe(0);
    const document = JSON.parse(run.stdout);
    expect(document.command).toBe("init");
    expect(document.result.config).toStrictEqual({
      sourceLanguage: "de",
      languages: ["en"],
      files: [{ source: "i18n/de.json", translation: "i18n/{lang}.json" }],
    });
    expect(run.stderr).toContain("i18n/de.json matches no files yet.");
  });
});

test("init refuses bad options", async () => {
  await withProject({}, async (dir) => {
    const cases: [string[], string][] = [
      [["init"], "--languages is required"],
      [["init", "--languages", "de,not a tag"], "isn't a valid BCP 47 language tag"],
      [["init", "--languages", "en"], "--languages: en is the source language."],
      [["init", "--languages", "de", "--files", "i18n/*.json"], "--translation is needed"],
      [["init", "--languages", "de", "--files", "../x/*.json"], "must stay inside"],
      [["init", "--languages", "de", "--translation", "x/{lang}/{file}"], "unknown placeholder"],
      // Regressions: an invalid glob was exit code 1, and a pattern inside the source glob
      // was accepted.
      [
        [
          "init",
          "--languages",
          "de",
          "--files",
          "src/[z-a]/en/*.json",
          "--translation",
          "src/{lang}/{path}",
        ],
        "isn't a valid glob",
      ],
      [
        [
          "init",
          "--languages",
          "de",
          "--files",
          "locales/**/*.json",
          "--translation",
          "locales/{lang}/{path}",
        ],
        "quaso upload would send them as source files",
      ],
    ];
    for (const [args, message] of cases) {
      const run = await runCli(args, { cwd: dir });
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stderr).toContain(message);
      expect(run.stderr.includes("a bug in quaso")).toBe(false);
    }
    const files = [];
    for await (const entry of await fs.readdir(dir, { withFileTypes: true }))
      files.push(entry.name);
    expect(files).toStrictEqual([]);
  });
});
