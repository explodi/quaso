// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
      expect(initialized.code, initialized.stderr).toBe(0);
      const result = JSON.parse(initialized.stdout).result;
      expect(result.config).toStrictEqual({
        sourceLanguage: "en",
        languages: ["pt-PT", "zh-Hans"],
        languageMapping: { "pt-PT": "pt", "zh-Hans": "zh" },
        files: [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
      });
      expect(result.proposals[0]).toContain("proposed zh-Hans");
      expect(initialized.stdout.includes("private-crowdin-token")).toBe(false);
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
        env: { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: "qso_test" },
        fetch,
      });
      expect(downloaded.code, downloaded.stderr).toBe(6);
      expect(await readFile(join(dir, "src/locales/pt/menu/play.json"), "utf8")).toStrictEqual(
        '{"play":"Old"}',
      );
      const replaced = await runCli(
        ["download", "--language", "pt-PT", "--overwrite-local", "--json"],
        {
          cwd: dir,
          env: { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: "qso_test" },
          fetch,
        },
      );
      expect(replaced.code, replaced.stderr).toBe(0);
      expect(JSON.parse(replaced.stdout).result.written[0].path).toStrictEqual(
        "src/locales/pt/menu/play.json",
      );
      expect(await readFile(join(dir, "src/locales/pt/menu/play.json"), "utf8")).toStrictEqual(
        content,
      );
      expect(await readFile(join(dir, "crowdin.yml"), "utf8")).toStrictEqual(YAML);
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
      expect(converted.files).toStrictEqual([
        { source: "src/en/**/*.json", translation: "{lang}/src/en/{path}" },
      ]);
      expect(converted.languageMapping).toStrictEqual({ "pt-PT": "pt_PT" });
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
      expect(converted.files[0].translation).toBe("{lang}/{path}");
      expect(converted.languageMapping).toStrictEqual({ de: "German" });
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
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("%android_code%");
      expect(await readdir(dir)).toStrictEqual(["crowdin.yml"]);
    },
  );
});

test("Crowdin malformed YAML diagnostics exclude credentials", async () => {
  await withProject({ "crowdin.yml": "api_token: [private-crowdin-token\n" }, async (dir) => {
    const run = await runCli(["init", "--from-crowdin"], { cwd: dir });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("invalid YAML");
    expect(run.stderr.includes("private-crowdin-token")).toBe(false);
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
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("without changing paths");
      expect(await readdir(dir)).toStrictEqual(["crowdin.yml"]);
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
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("preserve_hierarchy: true");
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
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout).result;
    expect(result.config.files.length).toBe(1);
    expect(result.warnings.join("\n")).toContain("%unsupported%");
    expect(result.warnings.join("\n")).toContain("export_only_approved");
    expect(await readFile(join(dir, "crowdin.yml"), "utf8")).toStrictEqual(yaml);
  });
});
