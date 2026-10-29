// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { sha256Hex } from "@quaso/core";
import { SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import {
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";

const COMMON = {
  title: "Wayfarer",
  menu: { play: "Play", quit: "Quit" },
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  back: "$t(menu.quit)",
  version: 3,
  hints: ["Run", ""],
};

async function project(): Promise<TestInstance> {
  const instance = await startTestService();
  await uploadJson(
    instance.service,
    { "common.json": COMMON, "hud.json": { hp: "HP" } },
    {
      languages: ["pl", "de"],
    },
  );
  return instance;
}

function content(result: { files: { path: string; language: string; content: string }[] }) {
  return Object.fromEntries(
    result.files.map((file) => [`${file.language}/${file.path}`, JSON.parse(file.content)]),
  );
}

test("export renders every file in every language, with SHA-256, byte-stable", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  const first = await instance.service.exportFiles(SYSTEM, {});
  expect(first.schemaVersion).toBe(1);
  expect(first.sourceLanguage).toBe("en");
  expect(first.revision).toBe(2);
  expect(first.files.map((file) => `${file.language}/${file.path}`)).toStrictEqual([
    "de/common.json",
    "de/hud.json",
    "pl/common.json",
    "pl/hud.json",
  ]);
  for (const file of first.files) expect(file.sha256).toStrictEqual(sha256Hex(file.content));
  const second = await instance.service.exportFiles(SYSTEM, {});
  expect(second).toStrictEqual(first);
  expect(first.files[0].content).toStrictEqual(
    [
      "{",
      '  "title": "Wegfahrer",',
      '  "menu": {',
      '    "play": "Play",',
      '    "quit": "Quit"',
      "  },",
      '  "coins_one": "{{count}} coin",',
      '  "coins_other": "{{count}} coins",',
      '  "back": "$t(menu.quit)",',
      '  "version": 3,',
      '  "hints": [',
      '    "Run",',
      '    ""',
      "  ]",
      "}",
      "",
    ].join("\n"),
  );
});

test("untranslated strings fall back to the English (FMT-2)", async () => {
  using instance = await project();
  const files = content(await instance.service.exportFiles(SYSTEM, { languages: ["de"] }));
  expect(files["de/common.json"]).toStrictEqual(COMMON);
  expect(files["de/hud.json"]).toStrictEqual({ hp: "HP" });
});

test("untranslated omit leaves the English out; published versions can't", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.play", "de", "Spielen");
  const query = { languages: ["de"], untranslated: "omit" as const };
  const files = content(await instance.service.exportFiles(SYSTEM, query));
  expect(files["de/common.json"]).toStrictEqual({
    menu: { play: "Spielen" },
    back: "$t(menu.quit)",
    version: 3,
  });
  expect(files["de/hud.json"]).toStrictEqual({});
  const at = new Date().toISOString().slice(0, 16) + "Z";
  const error = await instance.service
    .exportFiles(SYSTEM, { ...query, at })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("bad_request");
});

test("a Polish plural gets one, few, many and other", async () => {
  using instance = await project();
  write(instance, "common.json", "coins", "pl", {
    one: "{{count}} moneta",
    few: "{{count}} monety",
    many: "{{count}} monet",
    other: "{{count}} monety",
  });
  const files = content(await instance.service.exportFiles(SYSTEM, { languages: ["pl"] }));
  const common = files["pl/common.json"];
  expect(Object.keys(common).filter((key) => key.startsWith("coins"))).toStrictEqual([
    "coins_one",
    "coins_few",
    "coins_many",
    "coins_other",
  ]);
  expect(common.coins_few).toBe("{{count}} monety");
  const untranslated = content(await instance.service.exportFiles(SYSTEM, { languages: ["de"] }));
  expect(
    Object.keys(untranslated["de/common.json"]).filter((key) => key.startsWith("coins")),
  ).toStrictEqual(["coins_one", "coins_other"]);
});

test("a language's plural override decides its forms", async () => {
  using instance = await project();
  instance.sql.run(
    "UPDATE languages SET plural_override = ? WHERE tag = 'de'",
    JSON.stringify({ cardinal: ["one", "few", "other"] }),
  );
  const files = content(await instance.service.exportFiles(SYSTEM, { languages: ["de"] }));
  expect(
    Object.keys(files["de/common.json"]).filter((key) => key.startsWith("coins")),
  ).toStrictEqual(["coins_one", "coins_few", "coins_other"]);
});

test("pending suggestions are never exported", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  instance.sql.run(
    `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
       author_type, created_at) VALUES (?, 'de', 'correction', '"Reisender"', 'x', 2, 'user', 0)`,
    stringId(instance.sql, "common.json", "title"),
  );
  const files = content(await instance.service.exportFiles(SYSTEM, { languages: ["de"] }));
  expect(files["de/common.json"].title).toBe("Wegfahrer");
});

test("hidden strings and hidden files are never exported", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.quit", "de", "Beenden");
  await uploadJson(instance.service, { "common.json": { ...COMMON, menu: { play: "Play" } } });
  const result = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  expect(result.files.map((file) => file.path)).toStrictEqual(["common.json"]);
  expect(content(result)["de/common.json"].menu).toStrictEqual({ play: "Play" });
  await expect(instance.service.exportFiles(SYSTEM, { files: ["hud.json"] })).rejects.toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("hud.json"),
    }),
  );
});

test("outdated translations are still exported (STR-4)", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarer II" },
    "hud.json": { hp: "HP" },
  });
  const files = content(await instance.service.exportFiles(SYSTEM, { languages: ["de"] }));
  expect(files["de/common.json"].title).toBe("Wegfahrer");
});

test("the English file's format is kept: tabs and CRLF", async () => {
  using instance = await startTestService();
  await instance.service.upload(SYSTEM, {
    files: [
      {
        path: "a.json",
        repoPath: "a.json",
        content: '{\r\n\t"a": "A",\r\n\t"b": { "c": "C" }\r\n}',
      },
    ],
    languages: ["fr"],
  });
  const [file] = (await instance.service.exportFiles(SYSTEM, {})).files;
  expect(file.content).toStrictEqual(
    '{\r\n\t"a": "A",\r\n\t"b": {\r\n\t\t"c": "C"\r\n\t}\r\n}\r\n',
  );
});

test("languages and files can be chosen; unknown ones fail", async () => {
  using instance = await project();
  const some = await instance.service.exportFiles(SYSTEM, {
    languages: ["pl"],
    files: ["hud.json"],
  });
  expect(some.files.map((file) => `${file.language}/${file.path}`)).toStrictEqual(["pl/hud.json"]);
  const unknown = await instance.service
    .exportFiles(SYSTEM, { languages: ["fr"] })
    .catch((error: unknown) => error);
  assert(unknown instanceof ServiceError);
  expect([unknown.code, unknown.details]).toStrictEqual(["bad_request", [{ language: "fr" }]]);
  const source = await instance.service
    .exportFiles(SYSTEM, { languages: ["en"] })
    .catch((error: unknown) => error);
  assert(source instanceof ServiceError);
  expect(source.code).toBe("bad_request");
  const file = await instance.service
    .exportFiles(SYSTEM, { files: ["nope.json"] })
    .catch((error: unknown) => error);
  assert(file instanceof ServiceError);
  expect(file.code).toBe("not_found");
});

test("an instance without languages exports nothing", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } });
  expect((await instance.service.exportFiles(SYSTEM, {})).files).toStrictEqual([]);
});
