// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "@quaso/runtime/assert";
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
    assertEquals(run.code, 0, run.stderr);
    assertEquals(JSON.parse(run.stdout).result.config.languageMapping, {
      "zh-Hans": "zh",
      "pt-PT": "pt",
    });
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    assertEquals(
      translationPath(project, sources.files[0], "zh-Hans"),
      "src/locales/zh/menu/play.json",
    );
    assertEquals(
      translationPath(project, sources.files[0], "pt-PT"),
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
    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "more than one folder");
    assertEquals(await fs.readdir(dir), []);
  });
});

test("init refuses a mapped language outside its targets", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(["init", "--languages", "de", "--language-mapping", "zh-Hans=zh"], {
      cwd: dir,
    });
    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "not one of --languages");
    assertEquals(await fs.readdir(dir), []);
  });
});

test("init refuses unsafe language folder names", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(["init", "--languages", "de", "--language-mapping", "de=../outside"], {
      cwd: dir,
    });
    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "can't be a folder or file name");
    assertEquals(await fs.readdir(dir), []);
  });
});

test("init refuses malformed mapping entries", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(["init", "--languages", "de", "--language-mapping", "de"], {
      cwd: dir,
    });
    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "must be a language tag followed by =folder");
    assertEquals(await fs.readdir(dir), []);
  });
});

test("defaultTranslation replaces the source language's folder or file name", () => {
  assertEquals(defaultTranslation("src/locales/en/**/*.json", "en"), "src/locales/{lang}/{path}");
  assertEquals(
    defaultTranslation("public/locales/en/*.json", "en"),
    "public/locales/{lang}/{path}",
  );
  assertEquals(defaultTranslation("locales/en/app/*.json", "en"), "locales/{lang}/app/{path}");
  assertEquals(defaultTranslation("locales/en.json", "en"), "locales/{lang}.json");
  assertEquals(defaultTranslation("i18n/*.json", "en"), null);
});

test("init writes a starter config and never overwrites one", async () => {
  await withProject({ "src/locales/en/common.json": "{}" }, async (dir) => {
    const run = await runCli(["init", "--languages", "de,fr", "--languages", "pt-BR"], {
      cwd: dir,
      env: { QUASO_HOSTNAME: "translate.game.test" },
    });
    assertEquals(run.code, 0, run.stderr);
    assertStringIncludes(run.stdout, "src/locales/en/**/*.json (1 file found)");
    const config = JSON.parse(await fs.readFile(join(dir, "quaso.config.json"), "utf8"));
    assertEquals(config, {
      $schema: "https://translate.game.test/schema/config-v1.json",
      sourceLanguage: "en",
      languages: ["de", "fr", "pt-BR"],
      files: [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
    });
    const again = await runCli(["init", "--languages", "ja"], { cwd: dir });
    assertEquals(again.code, 2);
    assertStringIncludes(again.stderr, "init never overwrites it");
    assertEquals(JSON.parse(await fs.readFile(join(dir, "quaso.config.json"), "utf8")), config);
  });
});

test("init takes --source, --files and --translation, without $schema when no hostname", async () => {
  await withProject({}, async (dir) => {
    const run = await runCli(
      ["init", "--json", "--source", "de", "--languages", "en", "--files", "i18n/{source}.json"],
      { cwd: dir },
    );
    assertEquals(run.code, 0, run.stderr);
    const document = JSON.parse(run.stdout);
    assertEquals(document.command, "init");
    assertEquals(document.result.config, {
      sourceLanguage: "de",
      languages: ["en"],
      files: [{ source: "i18n/de.json", translation: "i18n/{lang}.json" }],
    });
    assertStringIncludes(run.stderr, "i18n/de.json matches no files yet.");
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
      assertEquals(run.code, 2, args.join(" "));
      assertStringIncludes(run.stderr, message);
      assertEquals(run.stderr.includes("a bug in quaso"), false);
    }
    const files = [];
    for await (const entry of await fs.readdir(dir, { withFileTypes: true }))
      files.push(entry.name);
    assertEquals(files, []);
  });
});
