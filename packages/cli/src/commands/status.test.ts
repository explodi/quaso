// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageProgress, StatusResult } from "@quaso/core";
import { CONFIG, fakeFetch, jsonResponse, runCli, withProject } from "../test_helpers.ts";

const ENV = { QUASO_HOSTNAME: "http://quaso.test", QUASO_API_KEY: "qso_read" };

function language(
  tag: string,
  counts: Partial<LanguageProgress>,
): StatusResult["languages"][number] {
  return {
    tag,
    name: tag,
    direction: "ltr",
    plural: { cardinal: ["one", "other"], ordinal: ["other"] },
    strings: 10,
    words: 20,
    untranslated: 0,
    green: 0,
    blue: 10,
    outdated: 0,
    pending: 0,
    qa: 0,
    wordsLeft: 0,
    translatedPercent: 100,
    proofreadPercent: 100,
    files: [],
    ...counts,
  };
}

const STATUS: StatusResult = {
  revision: 9,
  sourceLanguage: "en",
  languages: [
    language("de", {}),
    language("pl", {
      untranslated: 2,
      green: 3,
      blue: 5,
      translatedPercent: 80,
      proofreadPercent: 50,
    }),
    language("ja", { untranslated: 10, blue: 0, translatedPercent: 0, proofreadPercent: 0 }),
  ],
};

const PROJECT = { "quaso.config.json": CONFIG, "src/locales/en/common.json": "{}" };

async function status(args: string[], result: StatusResult = STATUS) {
  let code = 0;
  let stdout = "";
  let stderr = "";
  let url = "";
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() => jsonResponse(result));
    ({ code, stdout, stderr } = await runCli(["status", ...args], { cwd: dir, env: ENV, fetch }));
    url = fetch.requests[0]?.url ?? "";
  });
  return { code, stdout, stderr, url };
}

test("status prints a table of every language, marking those not in the config", async () => {
  const run = await status([]);
  assertEquals(run.code, 0, run.stderr);
  assertEquals(run.url, "http://quaso.test/api/v1/status");
  assertStringIncludes(run.stdout, "10 strings, 20 words (source language: en)");
  assertStringIncludes(
    run.stdout,
    "Untranslated  Green  Blue  Outdated  Pending  QA  Translated • Proofread",
  );
  assertStringIncludes(run.stdout, "80% • 50%");
  assertStringIncludes(run.stdout, "ja     ja *");
  assertStringIncludes(run.stdout, "* not in quaso.config.json");
});

test("status --fail-on counts only the config's languages: exit code 7 when met", async () => {
  const untranslated = await status(["--fail-on", "untranslated"]);
  assertEquals(untranslated.code, 7);
  assertStringIncludes(untranslated.stdout, "--fail-on untranslated: met (pl: 2 untranslated)");
  const green = await status(["--fail-on=outdated,green", "--json"]);
  assertEquals(green.code, 7);
  const document = JSON.parse(green.stdout);
  assertEquals(document.exitCode, 7);
  assertEquals(document.result.failOn, {
    states: ["outdated", "green"],
    met: true,
    hits: [{ language: "pl", state: "green", count: 3 }],
  });
  const outdated = await status(["--fail-on", "outdated"]);
  assertEquals(outdated.code, 0);
  assertStringIncludes(outdated.stdout, "--fail-on outdated: not met");
});

test("status --language narrows the table and the --fail-on count", async () => {
  const one = await status(["--language", "de", "--fail-on", "untranslated"]);
  assertEquals(one.code, 0, one.stderr);
  assertEquals(one.url, "http://quaso.test/api/v1/status", "every language, then narrowed");
  const ja = await status(["--language", "de,ja", "--fail-on", "untranslated"]);
  assertEquals(ja.code, 7);
  const unknown = await status(["--language", "de,xx"]);
  assertEquals(unknown.code, 2);
  assertStringIncludes(
    unknown.stderr,
    "The instance has no language xx, and quaso.config.json doesn't list it.",
  );
  const invalid = await status(["--language", "not a tag"]);
  assertEquals(invalid.code, 2);
});

// Regression: a config language that the instance lacks gave exit code 1 (a 404) with
// --language and one language, 2 with several, and 7 without --language.
test("status: a config language the instance lacks counts the same with or without --language", async () => {
  const lacking = { ...STATUS, languages: [STATUS.languages[0]] };
  for (const args of [[], ["--language", "pl"], ["--language", "pl,de"], ["--language", "PL"]]) {
    const run = await status([...args, "--fail-on", "untranslated", "--json"], lacking);
    assertEquals(run.code, 7, `${args.join(" ")}: ${run.stderr}`);
    assertEquals(JSON.parse(run.stdout).result.failOn.hits, [
      { language: "pl", state: "untranslated", count: 10 },
    ]);
    assertStringIncludes(run.stderr, "pl is in quaso.config.json but not on the instance yet");
  }
  const text = await status(["--language", "pl"], lacking);
  assertStringIncludes(text.stdout, "The instance doesn't have pl yet: quaso upload adds it.");
});

test("status: a config language the instance lacks is a warning, and untranslated", async () => {
  const run = await status(["--fail-on", "untranslated"], {
    ...STATUS,
    languages: [STATUS.languages[0]],
  });
  assertEquals(run.code, 7);
  assertStringIncludes(run.stderr, "pl is in quaso.config.json but not on the instance yet");
  assertStringIncludes(run.stdout, "pl: 10 untranslated");
});
