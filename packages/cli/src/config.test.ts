// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import * as fs from "node:fs/promises";
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
    expect(await findConfig(dir)).toStrictEqual(join(dir, "quaso.config.json"));
    expect(await findConfig(join(dir, "src", "locales"))).toStrictEqual(
      join(dir, "quaso.config.json"),
    );
    await fs.mkdir(join(dir, "src", "quaso.config.json"));
    expect(await findConfig(join(dir, "src"))).toStrictEqual(join(dir, "quaso.config.json"));
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
      expect(project.dir).toStrictEqual(dir);
      expect(project.languages).toStrictEqual(["de", "pt-BR"]);
      expect(project.sourceLanguage).toBe("en");
      expect(languageFolder(project, "pt-BR"), "the config's spelling").toBe("pt-br");
      const other = await loadProject(dir, "other/q.json");
      expect(other.dir).toStrictEqual(join(dir, "other"));
      expect(other.sourceLanguage).toBe("de");
    },
  );
});

test("loadProject: no config, or an unreadable one, is a usage error", async () => {
  await withProject({ "a.txt": "" }, async (dir) => {
    const error = await loadProject(dir).catch((error: unknown) => error);
    assert(error instanceof CliError);
    expect(error.exitCode).toBe(2);
    expect(error.code).toBe("config_not_found");
    const missing = await loadProject(dir, "nope.json").catch((error: unknown) => error);
    assert(missing instanceof CliError);
    expect(missing.exitCode).toBe(2);
  });
});

test("parseConfig reports syntax errors with the line and column", () => {
  const { config, problems } = parseConfig('{\n  "sourceLanguage": "en",\n  "languages": [}\n');
  expect(config).toBe(null);
  expect(problems.length).toBe(1);
  expect(problems[0].file).toBe("quaso.config.json");
  expect(problems[0].line).toBe(3);
  expect(problems[0].column).toBe(17);
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
  expect(key.message).toStrictEqual(
    "is not a known property: the API key only ever comes from QUASO_API_KEY",
  );
});

test("parseConfig: the source language isn't a target, and languages are unique", () => {
  const { problems } = parseConfig(text({ ...CONFIG, languages: ["de", "EN", "pt-BR", "pt-br"] }));
  expect(problems.map((problem) => [problem.key, problem.message])).toStrictEqual([
    ["languages[1]", "EN is the source language; it is never a target"],
    ["languages[3]", "pt-br is the same language as languages[2]"],
  ]);
});

test("parseConfig checks languageMapping: folder names, and no two languages in one", () => {
  const bad = parseConfig(
    text({
      ...CONFIG,
      languages: ["de", "zh-Hans", "zh-Hant"],
      languageMapping: { "zh-Hans": "zh/CN", "zh-Hant": "..", de: "DE" },
    }),
  );
  expect(bad.problems.map((problem) => problem.key)).toStrictEqual([
    'languageMapping["zh-Hans"]',
    'languageMapping["zh-Hant"]',
  ]);
  const shared = parseConfig(
    text({
      ...CONFIG,
      languages: ["de", "en-GB"],
      languageMapping: { "en-GB": "EN" },
    }),
  );
  expect(shared.problems.map((problem) => problem.message)).toStrictEqual([
    'en and en-GB would share the name "EN"',
  ]);
  const good = parseConfig(
    text({
      ...CONFIG,
      languages: ["de", "zh-Hans"],
      languageMapping: { "zh-hans": "zh-CN" },
    }),
  );
  expect(good.problems).toStrictEqual([]);
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
  expect(config!.files[0].source).toBe("src/locales/en/*.json");
  expect(config!.files[0].translation).toBe("src/locales/{lang}/{path}");
  expect(problems.map((problem) => `${problem.key}: ${problem.message}`)).toStrictEqual([
    "files[1].source: must be relative to the folder of quaso.config.json",
    "files[1].translation: has an unknown placeholder {file}: use {lang} and {path}",
    "files[2].source: must stay inside the folder of quaso.config.json (no ..)",
    "files[2].translation: must use / as the separator, not \\",
    "files[3].source: is a glob of the source files: {lang} and {path} go in translation",
    "files[3].exclude[0]: must stay inside the folder of quaso.config.json (no ..)",
  ]);
});

test("parseConfig refuses a folder that isn't a relative path of whole segments", () => {
  const mapping = { source: "text/en/*.md", translation: "text/{lang}/{path}" };
  const { problems } = parseConfig(
    text({
      ...CONFIG,
      files: [
        { ...mapping, folder: "paper/news" },
        { ...mapping, folder: "/paper" },
        { ...mapping, folder: "paper/" },
        { ...mapping, folder: "a/../b" },
      ],
    }),
  );
  expect(problems.map((problem) => problem.key)).toStrictEqual([
    "files[1].folder",
    "files[2].folder",
    "files[3].folder",
  ]);
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
  expect(problems.map((problem) => problem.key)).toStrictEqual([
    "files[0].source",
    "files[0].exclude[0]",
  ]);
  assert(problems[0].message.startsWith("isn't a valid glob: "), problems[0].message);
});

const AUTHOR_GENDER = {
  name: "authorGender",
  cases: ["female", "male"],
  description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
  files: ["feed.json"],
  keys: ["posts.*"],
};

test("parseConfig accepts declared arguments", () => {
  const { config, problems } = parseConfig(text({ ...CONFIG, arguments: [AUTHOR_GENDER] }));
  expect(problems).toStrictEqual([]);
  expect(config?.arguments).toStrictEqual([AUTHOR_GENDER]);
});

test("parseConfig refuses an argument name that ICU can't read", () => {
  const { problems } = parseConfig(
    text({ ...CONFIG, arguments: [{ ...AUTHOR_GENDER, name: "author-gender" }] }),
  );
  expect(problems).toStrictEqual([
    {
      file: "quaso.config.json",
      key: "arguments[0].name",
      message: "must be an ICU argument name: letters, digits, _ and $",
    },
  ]);
});

test("parseConfig refuses other among an argument's cases: it is always one", () => {
  const { problems } = parseConfig(
    text({ ...CONFIG, arguments: [{ ...AUTHOR_GENDER, cases: ["female", "male", "other"] }] }),
  );
  expect(problems).toStrictEqual([
    {
      file: "quaso.config.json",
      key: "arguments[0].cases[2]",
      message: "is always a case: leave it out",
    },
  ]);
});

test("parseConfig refuses an argument declared twice", () => {
  const { problems } = parseConfig(
    text({ ...CONFIG, arguments: [AUTHOR_GENDER, { ...AUTHOR_GENDER, files: ["chat.json"] }] }),
  );
  expect(problems).toStrictEqual([
    { file: "quaso.config.json", key: "arguments", message: "declare authorGender once" },
  ]);
});

test("parseConfig refuses an argument's key glob that can't be compiled", () => {
  const { problems } = parseConfig(
    text({ ...CONFIG, arguments: [{ ...AUTHOR_GENDER, keys: ["posts.[z-a]"] }] }),
  );
  expect(problems.map((problem) => problem.key)).toStrictEqual(["arguments[0].keys[0]"]);
});

// Regression (CLI-5): translations written inside the source glob were uploaded as English.
test("parseConfig refuses translation patterns that write into a source glob", () => {
  const inside = parseConfig(
    text({
      ...CONFIG,
      files: [{ source: "locales/**/*.json", translation: "locales/{lang}/{path}" }],
    }),
  );
  expect(inside.problems.map((problem) => problem.key)).toStrictEqual(["files[0].translation"]);
  expect(inside.problems[0].message).toContain(
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
  expect(other.problems.map((problem) => problem.key)).toStrictEqual(["files[0].translation"]);
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
  expect(excluded.problems).toStrictEqual([]);
  for (const files of [
    [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
    [{ source: "locales/en.json", translation: "locales/{lang}.json" }],
    [{ source: "i18n/*.en.json", translation: "i18n/{lang}/{path}" }],
  ]) {
    expect(parseConfig(text({ ...CONFIG, files })).problems, files[0].source).toStrictEqual([]);
  }
});

test("normalizePattern", () => {
  expect(normalizePattern("./a/./b/*.json")).toBe("a/b/*.json");
  expect(normalizePattern("a//b")).toStrictEqual({
    problem: "must not have empty segments (//) or end with /",
  });
  expect(normalizePattern("a/")).toStrictEqual({
    problem: "must not have empty segments (//) or end with /",
  });
});

test("serverUrl: QUASO_HOSTNAME wins over the config's hostname", async () => {
  await withProject(
    { "quaso.config.json": { ...CONFIG, hostname: "config.example" } },
    async (dir) => {
      const project = await loadProject(dir);
      expect(serverUrl({}, project)).toBe("https://config.example");
      expect(serverUrl({ QUASO_HOSTNAME: " env.example " }, project)).toStrictEqual(
        "https://env.example",
      );
      expect(serverUrl({ QUASO_HOSTNAME: "" }, project)).toBe("https://config.example");
    },
  );
  const error = await Promise.try(() => serverUrl({}, null)).catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(error.exitCode).toBe(2);
  expect(error.code).toBe("missing_hostname");
});

test("serverUrl: with an API key, a hostname only in the config is refused", async () => {
  await withProject(
    { "quaso.config.json": { ...CONFIG, hostname: "attacker.example" } },
    async (dir) => {
      const project = await loadProject(dir);
      const error = await Promise.try(() => serverUrl({ QUASO_API_KEY: "qso_abc" }, project)).catch(
        (error: unknown) => error,
      );
      assert(error instanceof CliError);
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe("missing_hostname");
      expect(error.hint?.includes("Set QUASO_HOSTNAME")).toBe(true);
    },
  );
});

test("serverUrl: with an API key, QUASO_HOSTNAME wins over the config's hostname", async () => {
  await withProject(
    { "quaso.config.json": { ...CONFIG, hostname: "attacker.example" } },
    async (dir) => {
      const project = await loadProject(dir);
      const env = { QUASO_API_KEY: "qso_abc", QUASO_HOSTNAME: "env.example" };
      expect(serverUrl(env, project)).toBe("https://env.example");
    },
  );
});

test("serverUrl: without an API key, the config's hostname is used", async () => {
  await withProject(
    { "quaso.config.json": { ...CONFIG, hostname: "config.example" } },
    async (dir) => {
      const project = await loadProject(dir);
      expect(serverUrl({ QUASO_API_KEY: " " }, project)).toBe("https://config.example");
    },
  );
});

test("parseServerUrl: a hostname means https; full URLs keep their scheme and path", () => {
  expect(parseServerUrl("translate.game.com", "x")).toBe("https://translate.game.com");
  expect(parseServerUrl("localhost:8000", "x")).toBe("https://localhost:8000");
  expect(parseServerUrl("http://localhost:8000/", "x")).toBe("http://localhost:8000");
  expect(parseServerUrl("HTTPS://Game.com/quaso//", "x")).toBe("https://game.com/quaso");
  for (const bad of ["ftp://game.com", "https://user:pw@game.com", "game.com/?a=1", "http://"]) {
    expect(() => parseServerUrl(bad, "x"), bad).toThrow(
      expect.objectContaining({ constructor: CliError, exitCode: 2 }),
    );
  }
});

test("parseServerUrl: plain http to a host other than loopback is refused", async () => {
  const error = await Promise.try(() => parseServerUrl("http://example.com", "x")).catch(
    (error: unknown) => error,
  );
  assert(error instanceof CliError);
  expect(error.exitCode).toBe(2);
  expect(error.code).toBe("invalid_hostname");
});

test("parseServerUrl: plain http to a name that only starts with localhost is refused", async () => {
  const error = await Promise.try(() => parseServerUrl("http://localhost.example.com", "x")).catch(
    (error: unknown) => error,
  );
  assert(error instanceof CliError);
  expect(error.code).toBe("invalid_hostname");
});

test("parseServerUrl: plain http to localhost is accepted", () => {
  expect(parseServerUrl("http://localhost:8000", "x")).toBe("http://localhost:8000");
});

test("parseServerUrl: plain http to 127.0.0.1 is accepted", () => {
  expect(parseServerUrl("http://127.0.0.1:8000", "x")).toBe("http://127.0.0.1:8000");
});

test("parseServerUrl: plain http to [::1] is accepted", () => {
  expect(parseServerUrl("http://[::1]:8123", "x")).toBe("http://[::1]:8123");
});

test("apiKey only comes from QUASO_API_KEY; missing is exit code 3", async () => {
  expect(apiKey({ QUASO_API_KEY: " qso_abc " })).toBe("qso_abc");
  const error = await Promise.try(() => apiKey({ QUASO_API_KEY: "  " })).catch(
    (error: unknown) => error,
  );
  assert(error instanceof CliError);
  expect(error.exitCode).toBe(3);
  expect(error.code).toBe("missing_key");
  // Regression: these were network errors (exit code 4, retried), and printed the key.
  for (const key of ["qso_abc\u201d", "qso_a\nb", "qso a", "qso_é"]) {
    const invalid = await Promise.try(() => apiKey({ QUASO_API_KEY: key })).catch(
      (error: unknown) => error,
    );
    assert(invalid instanceof CliError);
    expect(invalid.exitCode).toBe(3);
    expect(invalid.code).toBe("invalid_key");
    expect(invalid.message.includes("qso")).toBe(false);
  }
});
