// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@quaso/runtime/assert";
import { join } from "node:path";
import {
  apiKey,
  findConfig,
  languageFolder,
  loadProject,
  normalizePattern,
  parseConfig,
  parseServerUrl,
  serverUrl,
} from "./config.ts";
import { CliError } from "./errors.ts";
import { CONFIG, withProject } from "./test_helpers.ts";

const text = (config: unknown) => JSON.stringify(config, null, 2);

test("findConfig finds quaso.config.json here or in the nearest parent", async () => {
  await withProject({ "quaso.config.json": CONFIG, "src/locales/en/a.json": "{}" }, async (dir) => {
    assertEquals(await findConfig(dir), join(dir, "quaso.config.json"));
    assertEquals(await findConfig(join(dir, "src", "locales")), join(dir, "quaso.config.json"));
    await fs.mkdir(join(dir, "src", "quaso.config.json"));
    assertEquals(await findConfig(join(dir, "src")), join(dir, "quaso.config.json"));
  });
});

test("loadProject reads the nearest config, or --config", async () => {
  await withProject(
    {
      "quaso.config.json": { ...CONFIG, languages: ["de", "pt-br"] },
      "other/q.json": {
        ...CONFIG,
        sourceLanguage: "de",
        languages: ["en"],
        files: [{ source: "src/locales/de/**/*.json", translation: "src/locales/{lang}/{path}" }],
      },
      "sub/folder/.keep": "",
    },
    async (dir) => {
      const project = await loadProject(join(dir, "sub", "folder"));
      assertEquals(project.dir, dir);
      assertEquals(project.languages, ["de", "pt-BR"]);
      assertEquals(project.sourceLanguage, "en");
      assertEquals(languageFolder(project, "pt-BR"), "pt-br", "the config's spelling");
      const other = await loadProject(dir, "other/q.json");
      assertEquals(other.dir, join(dir, "other"));
      assertEquals(other.sourceLanguage, "de");
    },
  );
});

test("loadProject: no config, or an unreadable one, is a usage error", async () => {
  await withProject({ "a.txt": "" }, async (dir) => {
    const error = await assertRejects(() => loadProject(dir), CliError);
    assertEquals(error.exitCode, 2);
    assertEquals(error.code, "config_not_found");
    const missing = await assertRejects(() => loadProject(dir, "nope.json"), CliError);
    assertEquals(missing.exitCode, 2);
  });
});

test("parseConfig reports syntax errors with the line and column", () => {
  const { config, problems } = parseConfig('{\n  "sourceLanguage": "en",\n  "languages": [}\n');
  assertEquals(config, null);
  assertEquals(problems.length, 1);
  assertEquals(problems[0].file, "quaso.config.json");
  assertEquals(problems[0].line, 3);
  assertEquals(problems[0].column, 17);
});

test("parseConfig reports every schema problem, and points keys to the environment", () => {
  const { problems } = parseConfig(
    text({
      sourceLanguage: "en",
      languages: ["de", "not a tag"],
      files: [{ source: "a/*.json" }],
      apiKey: "secret",
    }),
  );
  const keys = problems.map((problem) => problem.key);
  assert(keys.includes("languages[1]"), JSON.stringify(problems));
  assert(keys.includes("files[0].translation"));
  const key = problems.find((problem) => problem.key === "apiKey")!;
  assertEquals(
    key.message,
    "is not a known property: the API key only ever comes from QUASO_API_KEY",
  );
});

test("parseConfig: the source language isn't a target, and languages are unique", () => {
  const { problems } = parseConfig(text({ ...CONFIG, languages: ["de", "EN", "pt-BR", "pt-br"] }));
  assertEquals(
    problems.map((problem) => [problem.key, problem.message]),
    [
      ["languages[1]", "EN is the source language; it is never a target"],
      ["languages[3]", "pt-br is the same language as languages[2]"],
    ],
  );
});

test("parseConfig checks languageMapping: folder names, and no two languages in one", () => {
  const bad = parseConfig(
    text({
      ...CONFIG,
      languages: ["de", "zh-Hans", "zh-Hant"],
      languageMapping: { "zh-Hans": "zh/CN", "zh-Hant": "..", de: "DE" },
    }),
  );
  assertEquals(
    bad.problems.map((problem) => problem.key),
    ['languageMapping["zh-Hans"]', 'languageMapping["zh-Hant"]'],
  );
  const shared = parseConfig(
    text({
      ...CONFIG,
      languages: ["de", "en-GB"],
      languageMapping: { "en-GB": "EN" },
    }),
  );
  assertEquals(
    shared.problems.map((problem) => problem.message),
    ['en and en-GB would share the name "EN"'],
  );
  const good = parseConfig(
    text({
      ...CONFIG,
      languages: ["de", "zh-Hans"],
      languageMapping: { "zh-hans": "zh-CN" },
    }),
  );
  assertEquals(good.problems, []);
});

test("parseConfig checks and normalizes the patterns", () => {
  const { config, problems } = parseConfig(
    text({
      ...CONFIG,
      files: [
        { source: "./src/locales/en/*.json", translation: "./src/locales/{lang}/{path}" },
        { source: "/abs/*.json", translation: "x/{lang}/{file}" },
        { source: "a/../b/*.json", translation: "C:\\x\\{lang}" },
        { source: "a/{lang}/*.json", translation: "{lang}/{path}", exclude: ["../x"] },
      ],
    }),
  );
  assertEquals(config!.files[0].source, "src/locales/en/*.json");
  assertEquals(config!.files[0].translation, "src/locales/{lang}/{path}");
  assertEquals(
    problems.map((problem) => `${problem.key}: ${problem.message}`),
    [
      "files[1].source: must be relative to the folder of quaso.config.json",
      "files[1].translation: has an unknown placeholder {file}: use {lang} and {path}",
      "files[2].source: must stay inside the folder of quaso.config.json (no ..)",
      "files[2].translation: must use / as the separator, not \\",
      "files[3].source: is a glob of the source files: {lang} and {path} go in translation",
      "files[3].exclude[0]: must stay inside the folder of quaso.config.json (no ..)",
    ],
  );
});

// Regression: an invalid glob in init was exit code 1, "a bug in quaso".
test("parseConfig refuses globs that can't be compiled", () => {
  const { problems } = parseConfig(
    text({
      ...CONFIG,
      files: [
        {
          source: "src/[z-a]/en/*.json",
          translation: "src/{lang}/{path}",
          exclude: ["src/[9-0]/x.json"],
        },
      ],
    }),
  );
  assertEquals(
    problems.map((problem) => problem.key),
    ["files[0].source", "files[0].exclude[0]"],
  );
  assert(problems[0].message.startsWith("isn't a valid glob: "), problems[0].message);
});

// Regression (CLI-5): translations written inside the source glob were uploaded as English.
test("parseConfig refuses translation patterns that write into a source glob", () => {
  const inside = parseConfig(
    text({
      ...CONFIG,
      files: [{ source: "locales/**/*.json", translation: "locales/{lang}/{path}" }],
    }),
  );
  assertEquals(
    inside.problems.map((problem) => problem.key),
    ["files[0].translation"],
  );
  assertStringIncludes(
    inside.problems[0].message,
    "writes translations such as locales/de/x.json, which files[0].source also matches",
  );
  const other = parseConfig(
    text({
      ...CONFIG,
      files: [
        { source: "a/en/*.json", translation: "b/{lang}/{path}" },
        { source: "b/**/*.json", translation: "c/{lang}/{path}" },
      ],
    }),
  );
  assertEquals(
    other.problems.map((problem) => problem.key),
    ["files[0].translation"],
  );
  const excluded = parseConfig(
    text({
      ...CONFIG,
      files: [
        {
          source: "locales/**/*.json",
          translation: "locales/{lang}/{path}",
          exclude: ["locales/{de,pl}/**"],
        },
      ],
    }),
  );
  assertEquals(excluded.problems, []);
  for (const files of [
    [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
    [{ source: "locales/en.json", translation: "locales/{lang}.json" }],
    [{ source: "i18n/*.en.json", translation: "i18n/{lang}/{path}" }],
  ]) {
    assertEquals(parseConfig(text({ ...CONFIG, files })).problems, [], files[0].source);
  }
});

test("normalizePattern", () => {
  assertEquals(normalizePattern("./a/./b/*.json"), "a/b/*.json");
  assertEquals(normalizePattern("a//b"), {
    problem: "must not have empty segments (//) or end with /",
  });
  assertEquals(normalizePattern("a/"), {
    problem: "must not have empty segments (//) or end with /",
  });
});

test("serverUrl: QUASO_HOSTNAME wins over the config's hostname", async () => {
  await withProject(
    { "quaso.config.json": { ...CONFIG, hostname: "config.example" } },
    async (dir) => {
      const project = await loadProject(dir);
      assertEquals(serverUrl({}, project), "https://config.example");
      assertEquals(serverUrl({ QUASO_HOSTNAME: " env.example " }, project), "https://env.example");
      assertEquals(serverUrl({ QUASO_HOSTNAME: "" }, project), "https://config.example");
    },
  );
  const error = assertThrows(() => serverUrl({}, null), CliError);
  assertEquals(error.exitCode, 2);
  assertEquals(error.code, "missing_hostname");
});

test("parseServerUrl: a hostname means https; full URLs keep their scheme and path", () => {
  assertEquals(parseServerUrl("translate.game.com", "x"), "https://translate.game.com");
  assertEquals(parseServerUrl("localhost:8000", "x"), "https://localhost:8000");
  assertEquals(parseServerUrl("http://localhost:8000/", "x"), "http://localhost:8000");
  assertEquals(parseServerUrl("HTTPS://Game.com/quaso//", "x"), "https://game.com/quaso");
  for (const bad of ["ftp://game.com", "https://user:pw@game.com", "game.com/?a=1", "http://"]) {
    assertEquals(assertThrows(() => parseServerUrl(bad, "x"), CliError).exitCode, 2, bad);
  }
});

test("apiKey only comes from QUASO_API_KEY; missing is exit code 3", () => {
  assertEquals(apiKey({ QUASO_API_KEY: " qso_abc " }), "qso_abc");
  const error = assertThrows(() => apiKey({ QUASO_API_KEY: "  " }), CliError);
  assertEquals(error.exitCode, 3);
  assertEquals(error.code, "missing_key");
  // Regression: these were network errors (exit code 4, retried), and printed the key.
  for (const key of ["qso_abc\u201d", "qso_a\nb", "qso a", "qso_é"]) {
    const invalid = assertThrows(() => apiKey({ QUASO_API_KEY: key }), CliError);
    assertEquals(invalid.exitCode, 3);
    assertEquals(invalid.code, "invalid_key");
    assertEquals(invalid.message.includes("qso"), false);
  }
});
