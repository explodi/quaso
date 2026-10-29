// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import type { LanguageProgress, StatusResult } from "@quaso/core";
import { CONFIG, fakeFetch, jsonResponse, runCli, withProject } from "../test_helpers.ts";

const ENV = { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: "qso_read" };

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
  expect(run.code, run.stderr).toBe(0);
  expect(run.url).toBe("https://quaso.test/api/v1/status");
  expect(run.stdout).toContain("10 strings, 20 words (source language: en)");
  expect(run.stdout).toContain(
    "Untranslated  Green  Blue  Outdated  Pending  QA  Translated • Proofread",
  );
  expect(run.stdout).toContain("80% • 50%");
  expect(run.stdout).toContain("ja     ja *");
  expect(run.stdout).toContain("* not in quaso.config.json");
});

test("status --fail-on counts only the config's languages: exit code 7 when met", async () => {
  const untranslated = await status(["--fail-on", "untranslated"]);
  expect(untranslated.code).toBe(7);
  expect(untranslated.stdout).toContain("--fail-on untranslated: met (pl: 2 untranslated)");
  const green = await status(["--fail-on=outdated,green", "--json"]);
  expect(green.code).toBe(7);
  const document = JSON.parse(green.stdout);
  expect(document.exitCode).toBe(7);
  expect(document.result.failOn).toStrictEqual({
    states: ["outdated", "green"],
    met: true,
    hits: [{ language: "pl", state: "green", count: 3 }],
  });
  const outdated = await status(["--fail-on", "outdated"]);
  expect(outdated.code).toBe(0);
  expect(outdated.stdout).toContain("--fail-on outdated: not met");
});

test("status --language narrows the table and the --fail-on count", async () => {
  const one = await status(["--language", "de", "--fail-on", "untranslated"]);
  expect(one.code, one.stderr).toBe(0);
  expect(one.url, "every language, then narrowed").toStrictEqual(
    "https://quaso.test/api/v1/status",
  );
  const ja = await status(["--language", "de,ja", "--fail-on", "untranslated"]);
  expect(ja.code).toBe(7);
  const unknown = await status(["--language", "de,xx"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain(
    "The instance has no language xx, and quaso.config.json doesn't list it.",
  );
  const invalid = await status(["--language", "not a tag"]);
  expect(invalid.code).toBe(2);
});

// Regression: a config language that the instance lacks gave exit code 1 (a 404) with
// --language and one language, 2 with several, and 7 without --language.
test("status: a config language the instance lacks counts the same with or without --language", async () => {
  const lacking = { ...STATUS, languages: [STATUS.languages[0]] };
  for (const args of [[], ["--language", "pl"], ["--language", "pl,de"], ["--language", "PL"]]) {
    const run = await status([...args, "--fail-on", "untranslated", "--json"], lacking);
    expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(7);
    expect(JSON.parse(run.stdout).result.failOn.hits).toStrictEqual([
      { language: "pl", state: "untranslated", count: 10 },
    ]);
    expect(run.stderr).toContain("pl is in quaso.config.json but not on the instance yet");
  }
  const text = await status(["--language", "pl"], lacking);
  expect(text.stdout).toContain("The instance doesn't have pl yet: quaso upload adds it.");
});

test("status: a config language the instance lacks is a warning, and untranslated", async () => {
  const run = await status(["--fail-on", "untranslated"], {
    ...STATUS,
    languages: [STATUS.languages[0]],
  });
  expect(run.code).toBe(7);
  expect(run.stderr).toContain("pl is in quaso.config.json but not on the instance yet");
  expect(run.stdout).toContain("pl: 10 untranslated");
});
