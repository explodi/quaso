// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ANONYMOUS, SYSTEM, type Service } from "@quaso/service";
import type { QuasoConfig } from "@quaso/core";
import { realService } from "../packages/server/src/testing/real_service.ts";
import { runCli, withProject } from "../packages/cli/src/test_helpers.ts";

const ROOT = fileURLToPath(new URL("fixtures/workflow/", import.meta.url));
const FILES = ["buildings.json", "common.json", "menu.json", "toolbox.json", "tutorial/steps.json"];

async function files(section: string, folder: string, paths = FILES) {
  return await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await readFile(join(ROOT, section, "src/locales", folder, path), "utf8"),
    })),
  );
}

async function upload(service: Service, config: QuasoConfig, section: string) {
  const sources = await files(section, "en");
  return await service.upload(SYSTEM, {
    sourceLanguage: config.sourceLanguage,
    languages: config.languages,
    files: sources.map((file) => ({ ...file, repoPath: `src/locales/en/${file.path}` })),
  });
}

async function importExports(service: Service, config: QuasoConfig) {
  for (const language of config.languages) {
    const folder = config.languageMapping?.[language] ?? language;
    const approved = language === "es" ? FILES : ["buildings.json"];
    await service.importTranslations(SYSTEM, {
      language,
      as: "blue",
      files: await files("crowdin-approved", folder, approved),
    });
    await service.importTranslations(SYSTEM, {
      language,
      as: "green",
      files: await files("crowdin-full", folder),
    });
  }
}

test("workflow fixture imports ten languages and opens five new Spanish entries before one outdated entry", async () => {
  const config: QuasoConfig = JSON.parse(
    await readFile(join(ROOT, "project/quaso.config.json"), "utf8"),
  );
  const instance = await realService();
  try {
    await instance.service.updateSettings(SYSTEM, { llm: { autoTranslate: false } });
    await upload(instance.service, config, "project");
    await importExports(instance.service, config);
    const initial = await instance.service.getProject(ANONYMOUS, {});
    expect([initial.details.files, initial.details.strings, initial.details.words]).toStrictEqual([
      5, 10, 20,
    ]);
    expect(
      initial.languages.map((language) => [
        language.tag,
        language.translatedPercent,
        language.blue,
        language.green,
      ]),
    ).toStrictEqual([
      ["de", 100, 2, 8],
      ["es", 100, 10, 0],
      ["fr", 100, 2, 8],
      ["it", 100, 2, 8],
      ["ja", 100, 2, 8],
      ["ko", 100, 2, 8],
      ["pl", 100, 2, 8],
      ["pt-PT", 100, 2, 8],
      ["tr", 100, 2, 8],
      ["zh-Hans", 100, 2, 8],
    ]);
    expect(initial.languages.map((language) => language.proofreadPercent)).toStrictEqual([
      20, 100, 20, 20, 20, 20, 20, 20, 20, 20,
    ]);
    const changed = await upload(instance.service, config, "updated");
    expect(changed.files.map((file) => [file.path, file.added, file.changed])).toStrictEqual([
      ["buildings.json", 1, 0],
      ["common.json", 1, 0],
      ["menu.json", 1, 1],
      ["toolbox.json", 1, 0],
      ["tutorial/steps.json", 1, 0],
    ]);
    const updated = await instance.service.getProject(ANONYMOUS, {});
    expect([updated.details.strings, updated.details.words]).toStrictEqual([15, 31]);
    expect(
      updated.languages.map((language) => [
        language.untranslated,
        language.outdated,
        language.wordsLeft,
      ]),
    ).toStrictEqual([
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
      [5, 1, 10],
    ]);
    const queue = await instance.service.getStringsQueue(ANONYMOUS, { language: "es" });
    expect(queue.toDo).toBe(6);
    const entries = await instance.service.listStrings(ANONYMOUS, {
      language: "es",
      ids: queue.ids.slice(0, 6),
    });
    const byId = new Map(entries.strings.map((entry) => [entry.id, entry]));
    expect(
      queue.ids.slice(0, 6).map((id) => {
        const entry = byId.get(id)!;
        return [entry.file, entry.key];
      }),
    ).toStrictEqual([
      ["buildings.json", "upgrade"],
      ["common.json", "reward"],
      ["menu.json", "resume"],
      ["toolbox.json", "repair"],
      ["tutorial/steps.json", "complete"],
      ["menu.json", "map"],
    ]);
    expect(config.languageMapping).toStrictEqual({ "pt-PT": "pt", "zh-Hans": "zh" });
  } finally {
    instance.close();
  }
});

test("workflow fixture Crowdin conversion retains all languages and nested download paths", async () => {
  const config: QuasoConfig = JSON.parse(
    await readFile(join(ROOT, "project/quaso.config.json"), "utf8"),
  );
  const sources = await files("project", "en");
  const project = Object.fromEntries(
    sources.map((file) => [`src/locales/en/${file.path}`, file.content]),
  );
  project["crowdin.yml"] = await readFile(join(ROOT, "project/crowdin.yml"), "utf8");
  await withProject(project, async (folder) => {
    const result = await runCli(
      [
        "init",
        "--from-crowdin",
        "crowdin.yml",
        "--languages",
        config.languages.join(","),
        "--json",
      ],
      { cwd: folder },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result.config).toStrictEqual(config);
  });
});
