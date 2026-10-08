// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
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
  assertEquals(first.schemaVersion, 1);
  assertEquals(first.sourceLanguage, "en");
  assertEquals(first.revision, 2);
  assertEquals(
    first.files.map((file) => `${file.language}/${file.path}`),
    ["de/common.json", "de/hud.json", "pl/common.json", "pl/hud.json"],
  );
  for (const file of first.files) assertEquals(file.sha256, sha256Hex(file.content));
  const second = await instance.service.exportFiles(SYSTEM, {});
  assertEquals(second, first);
  assertEquals(
    first.files[0].content,
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
  assertEquals(files["de/common.json"], COMMON);
  assertEquals(files["de/hud.json"], { hp: "HP" });
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
  assertEquals(
    Object.keys(common).filter((key) => key.startsWith("coins")),
    ["coins_one", "coins_few", "coins_many", "coins_other"],
  );
  assertEquals(common.coins_few, "{{count}} monety");
  const untranslated = content(await instance.service.exportFiles(SYSTEM, { languages: ["de"] }));
  assertEquals(
    Object.keys(untranslated["de/common.json"]).filter((key) => key.startsWith("coins")),
    ["coins_one", "coins_other"],
  );
});

test("a language's plural override decides its forms", async () => {
  using instance = await project();
  instance.sql.run(
    "UPDATE languages SET plural_override = ? WHERE tag = 'de'",
    JSON.stringify({ cardinal: ["one", "few", "other"] }),
  );
  const files = content(await instance.service.exportFiles(SYSTEM, { languages: ["de"] }));
  assertEquals(
    Object.keys(files["de/common.json"]).filter((key) => key.startsWith("coins")),
    ["coins_one", "coins_few", "coins_other"],
  );
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
  assertEquals(files["de/common.json"].title, "Wegfahrer");
});

test("hidden strings and hidden files are never exported", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.quit", "de", "Beenden");
  await uploadJson(instance.service, { "common.json": { ...COMMON, menu: { play: "Play" } } });
  const result = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  assertEquals(
    result.files.map((file) => file.path),
    ["common.json"],
  );
  assertEquals(content(result)["de/common.json"].menu, { play: "Play" });
  await assertRejects(
    () => instance.service.exportFiles(SYSTEM, { files: ["hud.json"] }),
    ServiceError,
    "hud.json",
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
  assertEquals(files["de/common.json"].title, "Wegfahrer");
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
  assertEquals(file.content, '{\r\n\t"a": "A",\r\n\t"b": {\r\n\t\t"c": "C"\r\n\t}\r\n}\r\n');
});

test("languages and files can be chosen; unknown ones fail", async () => {
  using instance = await project();
  const some = await instance.service.exportFiles(SYSTEM, {
    languages: ["pl"],
    files: ["hud.json"],
  });
  assertEquals(
    some.files.map((file) => `${file.language}/${file.path}`),
    ["pl/hud.json"],
  );
  const unknown = await assertRejects(
    () => instance.service.exportFiles(SYSTEM, { languages: ["fr"] }),
    ServiceError,
  );
  assertEquals([unknown.code, unknown.details], ["bad_request", [{ language: "fr" }]]);
  const source = await assertRejects(
    () => instance.service.exportFiles(SYSTEM, { languages: ["en"] }),
    ServiceError,
  );
  assertEquals(source.code, "bad_request");
  const file = await assertRejects(
    () => instance.service.exportFiles(SYSTEM, { files: ["nope.json"] }),
    ServiceError,
  );
  assertEquals(file.code, "not_found");
});

test("an instance without languages exports nothing", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } });
  assertEquals((await instance.service.exportFiles(SYSTEM, {})).files, []);
});
