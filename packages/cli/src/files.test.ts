// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@quaso/runtime/assert";
import { join } from "node:path";
import { loadProject } from "./config.ts";
import { CliError } from "./errors.ts";
import {
  checkOutputPath,
  collectSources,
  projectPath,
  resolveFileArgs,
  selectTranslations,
  translationPath,
} from "./files.ts";
import { CONFIG, withProject } from "./test_helpers.ts";

const ENGLISH = {
  "src/locales/en/common.json": "{}",
  "src/locales/en/menus/main.json": "{}",
  "src/locales/en/menus/options.json": "{}",
};

test("collectSources: server paths below the glob's folder, with / separators", async () => {
  await withProject({ "quaso.config.json": CONFIG, ...ENGLISH }, async (dir) => {
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    assertEquals(
      sources.files.map((file) => [file.server, file.local]),
      [
        ["common.json", "src/locales/en/common.json"],
        ["menus/main.json", "src/locales/en/menus/main.json"],
        ["menus/options.json", "src/locales/en/menus/options.json"],
      ],
    );
    for (const file of sources.files) {
      assert(!file.server.includes("\\") && !file.local.includes("\\"));
    }
    assertEquals(sources.warnings, []);
  });
});

test("translationPath: {lang} after languageMapping, {path} with its folders", async () => {
  await withProject(
    {
      "quaso.config.json": {
        ...CONFIG,
        languages: ["de", "zh-Hans", "pt-BR"],
        languageMapping: { "zh-Hans": "zh-CN", "pt-BR": "pt_BR" },
        files: [
          { source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" },
          { source: "store/en.json", translation: "store/{lang}.json" },
        ],
      },
      ...ENGLISH,
      "store/en.json": "{}",
    },
    async (dir) => {
      const project = await loadProject(dir);
      const sources = await collectSources(project);
      const main = sources.byServer.get("menus/main.json")!;
      assertEquals(translationPath(project, main, "de"), "src/locales/de/menus/main.json");
      assertEquals(translationPath(project, main, "zh-Hans"), "src/locales/zh-CN/menus/main.json");
      assertEquals(translationPath(project, main, "pt-BR"), "src/locales/pt_BR/menus/main.json");
      assertEquals(translationPath(project, main, "fr"), "src/locales/fr/menus/main.json");
      const store = sources.byServer.get("en.json")!;
      assertEquals(store.local, "store/en.json");
      assertEquals(translationPath(project, store, "zh-Hans"), "store/zh-CN.json");
    },
  );
});

test("collectSources refuses two files with one server path, and non-JSON files", async () => {
  await withProject(
    {
      "quaso.config.json": {
        ...CONFIG,
        files: [
          { source: "a/en/*.json", translation: "a/{lang}/{path}" },
          { source: "b/en/*", translation: "b/{lang}/{path}" },
        ],
      },
      "a/en/common.json": "{}",
      "b/en/common.json": "{}",
      "b/en/readme.md": "",
    },
    async (dir) => {
      const error = await assertRejects(
        async () => collectSources(await loadProject(dir)),
        CliError,
      );
      assertEquals(error.exitCode, 2);
      assertEquals(
        error.details.map((detail) => detail.message),
        [
          "b/en/common.json and a/en/common.json would both be common.json on the server",
          "b/en/readme.md isn't a .json file: narrow the glob, or add it to exclude",
        ],
      );
    },
  );
});

test("collectSources: no files at all is an error; an empty glob is a warning", async () => {
  await withProject({ "quaso.config.json": CONFIG }, async (dir) => {
    const error = await assertRejects(async () => collectSources(await loadProject(dir)), CliError);
    assertEquals(error.code, "no_source_files");
  });
  await withProject(
    {
      "quaso.config.json": {
        ...CONFIG,
        files: [...CONFIG.files, { source: "other/en/*.json", translation: "other/{lang}/{path}" }],
      },
      ...ENGLISH,
    },
    async (dir) => {
      const sources = await collectSources(await loadProject(dir));
      assertEquals(sources.warnings, ["files[1].source (other/en/*.json) matches no files."]);
    },
  );
});

test("checkOutputPath refuses the source language, source files, the config and outside paths", async () => {
  await withProject({ "quaso.config.json": CONFIG, ...ENGLISH }, async (dir) => {
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    checkOutputPath(project, sources, "src/locales/de/common.json", "de");
    const refused = (path: string, language: string, why: string) => {
      const error = assertThrows(() => checkOutputPath(project, sources, path, language), CliError);
      assertEquals(error.exitCode, 2);
      assertEquals(error.code, "unsafe_path");
      assert(error.message.includes(why), error.message);
    };
    refused("src/locales/en/common.json", "en", "the source language");
    refused("src/locales/de/x.json", "EN", "the source language");
    refused("src/locales/en/common.json", "de", "it is a source file");
    refused("SRC/Locales/EN/Common.json", "de", "it is a source file");
    refused("QUASO.config.json", "de", "the config file");
    refused("../outside.json", "de", "outside the project folder");
    refused("src/../../outside.json", "de", "outside the project folder");
    refused("/etc/passwd", "de", "outside the project folder");
    refused("src//x.json", "de", "outside the project folder");
  });
});

test("resolveFileArgs: server paths and source paths, not translation paths", async () => {
  await withProject({ "quaso.config.json": CONFIG, ...ENGLISH }, async (dir) => {
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    const resolve = (args: string[], cwd = dir) =>
      resolveFileArgs(project, sources, cwd, args).map((file) => file.server);
    assertEquals(resolve(["common.json"]), ["common.json"]);
    assertEquals(resolve(["menus\\main.json", "./common.json"]), [
      "common.json",
      "menus/main.json",
    ]);
    assertEquals(resolve(["src/locales/en/menus/main.json"]), ["menus/main.json"]);
    assertEquals(resolve(["main.json"], join(dir, "src", "locales", "en", "menus")), [
      "menus/main.json",
    ]);
    const error = assertThrows(() => resolve(["src/locales/pl/menus/options.json"]), CliError);
    assertEquals(error.exitCode, 2);
    assertEquals(error.code, "unknown_file");
    assertThrows(() => resolve(["../elsewhere.json"]), CliError);
  });
});

test("selectTranslations: a translation file's path names its language only", async () => {
  await withProject({ "quaso.config.json": CONFIG, ...ENGLISH }, async (dir) => {
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    const select = (languages: string[], files: string[]) => {
      const selection = selectTranslations(project, sources, dir, languages, files);
      const all = selection.files ?? sources.files;
      return {
        languages: selection.languages,
        pairs: selection.languages.flatMap((language) =>
          all
            .filter((file) => selection.wants(file.server, language))
            .map((file) => `${language}:${file.server}`),
        ),
      };
    };
    assertEquals(select([], []).languages, ["de", "pl"]);
    assertEquals(select(["DE"], []).languages, ["de"]);
    assertEquals(select([], ["src/locales/pl/menus/options.json"]), {
      languages: ["pl"],
      pairs: ["pl:menus/options.json"],
    });
    assertEquals(select([], ["common.json", "src/locales/pl/menus/options.json"]), {
      languages: ["de", "pl"],
      pairs: ["de:common.json", "pl:common.json", "pl:menus/options.json"],
    });
    assertEquals(select(["pl"], ["src/locales/pl/common.json"]).pairs, ["pl:common.json"]);
    // A language outside the config, named by --language, has translation paths too.
    assertEquals(select(["fr"], ["src/locales/fr/common.json"]).pairs, ["fr:common.json"]);
    const conflict = assertThrows(() => select(["de"], ["src/locales/pl/common.json"]), CliError);
    assertEquals(conflict.exitCode, 2);
    assert(conflict.message.includes("is a translation file of pl, but --language is de"));
    assertEquals(assertThrows(() => select(["en"], []), CliError).exitCode, 2);
    assertEquals(assertThrows(() => select(["../x"], []), CliError).exitCode, 2);
  });
});

test("projectPath: relative with /, or null outside", async () => {
  await withProject({ "quaso.config.json": CONFIG, ...ENGLISH }, async (dir) => {
    const project = await loadProject(dir);
    assertEquals(projectPath(project, join(dir, "src", "a.json")), "src/a.json");
    assertEquals(projectPath(project, dir), null);
    assertEquals(projectPath(project, join(dir, "..", "x.json")), null);
  });
});
