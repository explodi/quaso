// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@quaso/runtime/assert";
import { sha256Hex } from "@quaso/core";
import { convertCrowdin } from "./crowdin.ts";
import { fakeFetch, jsonResponse, runCli, withProject } from "./test_helpers.ts";

const YAML = `preserve_hierarchy: true
base_path: .
api_token: private-crowdin-token
files:
  - source: /src/locales/en/**/*.json
    translation: /src/locales/%two_letters_code%/**/%original_file_name%
    languages_mapping:
      two_letters_code:
        pt-PT: pt
`;

test("Crowdin init and download retain nested exported paths and infer languages", async () => {
  await withProject(
    {
      "crowdin.yml": YAML,
      "src/locales/en/menu/play.json": '{"play":"Play"}',
      "src/locales/pt/menu/play.json": '{"play":"Old"}',
      "src/locales/zh/menu/play.json": '{"play":"Old"}',
    },
    async (dir) => {
      const initialized = await runCli(["init", "--from-crowdin", "--json"], { cwd: dir });
      assertEquals(initialized.code, 0, initialized.stderr);
      const result = JSON.parse(initialized.stdout).result;
      assertEquals(result.config, {
        sourceLanguage: "en",
        languages: ["pt-PT", "zh-Hans"],
        languageMapping: { "pt-PT": "pt", "zh-Hans": "zh" },
        files: [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
      });
      assertStringIncludes(result.proposals[0], "proposed zh-Hans");
      assertEquals(initialized.stdout.includes("private-crowdin-token"), false);
      const content = '{"play":"Jogar"}';
      const fetch = fakeFetch(() =>
        jsonResponse({
          schemaVersion: 1,
          revision: 1,
          sourceLanguage: "en",
          files: [
            { path: "menu/play.json", language: "pt-PT", content, sha256: sha256Hex(content) },
          ],
        }),
      );
      const downloaded = await runCli(["download", "--language", "pt-PT", "--json"], {
        cwd: dir,
        env: { QUASO_HOSTNAME: "http://quaso.test", QUASO_API_KEY: "qso_test" },
        fetch,
      });
      assertEquals(downloaded.code, 0, downloaded.stderr);
      assertEquals(
        JSON.parse(downloaded.stdout).result.written[0].path,
        "src/locales/pt/menu/play.json",
      );
      assertEquals(await readFile(join(dir, "src/locales/pt/menu/play.json"), "utf8"), content);
      assertEquals(await readFile(join(dir, "crowdin.yml"), "utf8"), YAML);
    },
  );
});

test("Crowdin original_path keeps the full source base with locale mappings", async () => {
  await withProject(
    {
      "custom.yml": `preserve_hierarchy: true
files:
  - source: /src/en/**/*.json
    translation: /%locale%/%original_path%/%original_file_name%
    languages_mapping:
      locale:
        pt-PT: pt_PT
`,
    },
    async (dir) => {
      const converted = await convertCrowdin(dir, "custom.yml", "en");
      assertEquals(converted.files, [
        { source: "src/en/**/*.json", translation: "{lang}/src/en/{path}" },
      ]);
      assertEquals(converted.languageMapping, { "pt-PT": "pt_PT" });
    },
  );
});

test("Crowdin language-name placeholder uses explicit folder mappings", async () => {
  await withProject(
    {
      "crowdin.yml": `files:
  - source: /en/*.json
    translation: /%language%/%original_file_name%
    languages_mapping:
      language:
        de: German
`,
    },
    async (dir) => {
      const converted = await convertCrowdin(dir, "crowdin.yml", "en");
      assertEquals(converted.files[0].translation, "{lang}/{path}");
      assertEquals(converted.languageMapping, { de: "German" });
    },
  );
});

test("Crowdin unsupported placeholders are reported without writing a config", async () => {
  await withProject(
    {
      "crowdin.yml": `files:
  - source: /en/*.json
    translation: /%android_code%/%original_file_name%
`,
    },
    async (dir) => {
      const run = await runCli(["init", "--from-crowdin", "--languages", "de"], { cwd: dir });
      assertEquals(run.code, 2);
      assertStringIncludes(run.stderr, "%android_code%");
      assertEquals(await readdir(dir), ["crowdin.yml"]);
    },
  );
});

test("Crowdin malformed YAML diagnostics exclude credentials", async () => {
  await withProject({ "crowdin.yml": "api_token: [private-crowdin-token\n" }, async (dir) => {
    const run = await runCli(["init", "--from-crowdin"], { cwd: dir });
    assertEquals(run.code, 2);
    assertStringIncludes(run.stderr, "invalid YAML");
    assertEquals(run.stderr.includes("private-crowdin-token"), false);
  });
});

test("Crowdin recursive flattening is reported instead of changing download paths", async () => {
  await withProject(
    {
      "crowdin.yml": `files:
  - source: /en/**/*.json
    translation: /%locale%/%original_file_name%
`,
    },
    async (dir) => {
      const run = await runCli(["init", "--from-crowdin", "--languages", "de"], { cwd: dir });
      assertEquals(run.code, 2);
      assertStringIncludes(run.stderr, "without changing paths");
      assertEquals(await readdir(dir), ["crowdin.yml"]);
    },
  );
});

test("Crowdin original_path requires explicit preserved hierarchy", async () => {
  await withProject(
    {
      "crowdin.yml": `files:
  - source: /en/**/*.json
    translation: /%locale%/%original_path%/%original_file_name%
`,
    },
    async (dir) => {
      const run = await runCli(["init", "--from-crowdin", "--languages", "de"], { cwd: dir });
      assertEquals(run.code, 2);
      assertStringIncludes(run.stderr, "preserve_hierarchy: true");
    },
  );
});

test("Crowdin partial conversion reports unsupported entries and leaves the source config intact", async () => {
  const yaml = `files:
  - source: /en/*.json
    translation: /%locale%/%original_file_name%
    export_only_approved: true
  - source: /other/*.json
    translation: /%unsupported%/%original_file_name%
`;
  await withProject({ "crowdin.yml": yaml }, async (dir) => {
    const run = await runCli(
      ["init", "--from-crowdin", "crowdin.yml", "--languages", "de", "--json"],
      { cwd: dir },
    );
    assertEquals(run.code, 0, run.stderr);
    const result = JSON.parse(run.stdout).result;
    assertEquals(result.config.files.length, 1);
    assertStringIncludes(result.warnings.join("\n"), "%unsupported%");
    assertStringIncludes(result.warnings.join("\n"), "export_only_approved");
    assertEquals(await readFile(join(dir, "crowdin.yml"), "utf8"), yaml);
  });
});
