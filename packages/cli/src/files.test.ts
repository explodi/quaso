// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
    expect(sources.files.map((file) => [file.server, file.local])).toStrictEqual([
      ["common.json", "src/locales/en/common.json"],
      ["menus/main.json", "src/locales/en/menus/main.json"],
      ["menus/options.json", "src/locales/en/menus/options.json"],
    ]);
    for (const file of sources.files) {
      assert(!file.server.includes("\\") && !file.local.includes("\\"));
    }
    expect(sources.warnings).toStrictEqual([]);
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
      expect(translationPath(project, main, "de")).toBe("src/locales/de/menus/main.json");
      expect(translationPath(project, main, "zh-Hans")).toStrictEqual(
        "src/locales/zh-CN/menus/main.json",
      );
      expect(translationPath(project, main, "pt-BR")).toStrictEqual(
        "src/locales/pt_BR/menus/main.json",
      );
      expect(translationPath(project, main, "fr")).toBe("src/locales/fr/menus/main.json");
      const store = sources.byServer.get("en.json")!;
      expect(store.local).toBe("store/en.json");
      expect(translationPath(project, store, "zh-Hans")).toBe("store/zh-CN.json");
    },
  );
});

test("a mapping's folder: the server path is inside it, and {path} is not", async () => {
  await withProject(
    {
      "quaso.config.json": {
        ...CONFIG,
        files: [
          { source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" },
          { source: "text/en/**/*.md", translation: "text/{lang}/{path}", folder: "text" },
        ],
      },
      ...ENGLISH,
      "text/en/news/storm.md": "Storm\n",
    },
    async (dir) => {
      const project = await loadProject(dir);
      const sources = await collectSources(project);
      const storm = sources.byServer.get("text/news/storm.md")!;
      expect([storm.local, storm.path]).toStrictEqual(["text/en/news/storm.md", "news/storm.md"]);
      expect(translationPath(project, storm, "de")).toBe("text/de/news/storm.md");
      expect(sources.byServer.get("menus/main.json")?.local).toStrictEqual(
        "src/locales/en/menus/main.json",
      );
    },
  );
});

test("collectSources refuses two files with one server path, and files of other formats", async () => {
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
      "b/en/readme.txt": "",
    },
    async (dir) => {
      const error = await (async () => collectSources(await loadProject(dir)))().catch(
        (error: unknown) => error,
      );
      assert(error instanceof CliError);
      expect(error.exitCode).toBe(2);
      expect(error.details.map((detail) => detail.message)).toStrictEqual([
        "b/en/common.json and a/en/common.json would both be common.json on the server",
        "b/en/readme.txt isn't a .json, .md or .markdown file: narrow the glob, or add it to exclude",
      ]);
    },
  );
});

test("collectSources: no files at all is an error; an empty glob is a warning", async () => {
  await withProject({ "quaso.config.json": CONFIG }, async (dir) => {
    const error = await (async () => collectSources(await loadProject(dir)))().catch(
      (error: unknown) => error,
    );
    assert(error instanceof CliError);
    expect(error.code).toBe("no_source_files");
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
      expect(sources.warnings).toStrictEqual([
        "files[1].source (other/en/*.json) matches no files.",
      ]);
    },
  );
});

test("checkOutputPath refuses the source language, source files, the config and outside paths", async () => {
  await withProject({ "quaso.config.json": CONFIG, ...ENGLISH }, async (dir) => {
    const project = await loadProject(dir);
    const sources = await collectSources(project);
    checkOutputPath(project, sources, "src/locales/de/common.json", "de");
    const refused = async (path: string, language: string, why: string) => {
      const error = await Promise.try(() =>
        checkOutputPath(project, sources, path, language),
      ).catch((error: unknown) => error);
      assert(error instanceof CliError);
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe("unsafe_path");
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
    expect(resolve(["common.json"])).toStrictEqual(["common.json"]);
    expect(resolve(["menus\\main.json", "./common.json"])).toStrictEqual([
      "common.json",
      "menus/main.json",
    ]);
    expect(resolve(["src/locales/en/menus/main.json"])).toStrictEqual(["menus/main.json"]);
    expect(resolve(["main.json"], join(dir, "src", "locales", "en", "menus"))).toStrictEqual([
      "menus/main.json",
    ]);
    const error = await Promise.try(() => resolve(["src/locales/pl/menus/options.json"])).catch(
      (error: unknown) => error,
    );
    assert(error instanceof CliError);
    expect(error.exitCode).toBe(2);
    expect(error.code).toBe("unknown_file");
    expect(() => resolve(["../elsewhere.json"])).toThrow(CliError);
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
    expect(select([], []).languages).toStrictEqual(["de", "pl"]);
    expect(select(["DE"], []).languages).toStrictEqual(["de"]);
    expect(select([], ["src/locales/pl/menus/options.json"])).toStrictEqual({
      languages: ["pl"],
      pairs: ["pl:menus/options.json"],
    });
    expect(select([], ["common.json", "src/locales/pl/menus/options.json"])).toStrictEqual({
      languages: ["de", "pl"],
      pairs: ["de:common.json", "pl:common.json", "pl:menus/options.json"],
    });
    expect(select(["pl"], ["src/locales/pl/common.json"]).pairs).toStrictEqual(["pl:common.json"]);
    // A language outside the config, named by --language, has translation paths too.
    expect(select(["fr"], ["src/locales/fr/common.json"]).pairs).toStrictEqual(["fr:common.json"]);
    const conflict = await Promise.try(() => select(["de"], ["src/locales/pl/common.json"])).catch(
      (error: unknown) => error,
    );
    assert(conflict instanceof CliError);
    expect(conflict.exitCode).toBe(2);
    assert(conflict.message.includes("is a translation file of pl, but --language is de"));
    expect(() => select(["en"], [])).toThrow(
      expect.objectContaining({ constructor: CliError, exitCode: 2 }),
    );
    expect(() => select(["../x"], [])).toThrow(
      expect.objectContaining({ constructor: CliError, exitCode: 2 }),
    );
  });
});

test("projectPath: relative with /, or null outside", async () => {
  await withProject({ "quaso.config.json": CONFIG, ...ENGLISH }, async (dir) => {
    const project = await loadProject(dir);
    expect(projectPath(project, join(dir, "src", "a.json"))).toBe("src/a.json");
    expect(projectPath(project, dir)).toBe(null);
    expect(projectPath(project, join(dir, "..", "x.json"))).toBe(null);
  });
});
