// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { SYSTEM } from "@quaso/service";
import {
  DEMO_SUGGESTIONS,
  DEMO_VOLUNTEER,
  demoDir,
  globBase,
  readProjectFiles,
  seedDemo,
} from "./dev_seed.ts";
import { call, testApp } from "./testing/helpers.ts";
import { realService } from "./testing/real_service.ts";

test("seed: the folder where a glob starts", () => {
  expect(globBase("src/locales/en/**/*.json")).toBe("src/locales/en");
  expect(globBase("locales/en/*.json")).toBe("locales/en");
  expect(globBase("en/common.json")).toBe("en");
  expect(globBase("*.json")).toBe("");
});

test("seed: the demo project's files, read as the CLI would", async () => {
  const { config, sources, translations } = await readProjectFiles(demoDir());
  expect(config.sourceLanguage).toBe("en");
  expect(config.languages).toStrictEqual(["de", "fr", "pl", "ja", "ar", "pt-BR"]);
  expect(config.limits).toStrictEqual([{ file: "store.json", key: "title", maxLength: 30 }]);
  expect(sources.map((file) => file.path)).toStrictEqual([
    "common.json",
    "menus.json",
    "store.json",
  ]);
  const found = [...translations].map(([language, files]) => [language, files.map((f) => f.path)]);
  expect(found).toStrictEqual([
    ["de", ["common.json", "menus.json", "store.json"]],
    ["fr", ["common.json", "menus.json"]],
    ["pl", ["common.json", "menus.json", "store.json"]],
  ]);
});

test("seed: the demo project, partly translated, with a development key", {}, async () => {
  const real = await realService({ dev: true });
  try {
    const { apiKey, imports } = await seedDemo(real.service, demoDir(), { people: true });
    expect(apiKey).toMatch(/^qso_/);
    for (const result of imports) {
      expect(result.refused, result.language).toStrictEqual([]);
      expect(result.unknownKeys, result.language).toStrictEqual([]);
      expect(result.unknownFiles, result.language).toStrictEqual([]);
    }
    const status = await real.service.getStatus(SYSTEM, {});
    const counts = Object.fromEntries(
      status.languages.map((l) => [l.tag, [l.strings, l.untranslated, l.green, l.blue]]),
    );
    expect(counts.de).toStrictEqual([40, 0, 0, 40]);
    expect(counts.pl).toStrictEqual([40, 0, 40, 0]);
    expect(counts.fr[3]).toBe(0);
    expect(counts.fr[1] > 0 && counts.fr[2] > 0).toBe(true);
    for (const tag of ["ja", "ar", "pt-BR"]) expect(counts[tag]).toStrictEqual([40, 40, 0, 0]);

    const { app } = testApp(real.service);
    const upload = await call(app, "/api/v1/sources", {
      method: "POST",
      key: apiKey,
      json: { files: (await readProjectFiles(demoDir())).sources, dryRun: true },
    });
    expect(upload.status).toBe(200);
    expect((await upload.json()).dryRun).toBe(true);

    // The developer account (an administrator), and the demo volunteer's suggestions.
    const developer = await real.service.ensureDevAccount(SYSTEM, {});
    expect([developer.displayName, developer.role]).toStrictEqual(["Developer", "administrator"]);
    const members = await real.service.listMembers(SYSTEM, {});
    expect(
      members.members.map((m) => [m.displayName, m.role, m.languages, m.contributions]),
    ).toStrictEqual([
      ["Developer", "administrator", null, 0],
      ["Demo Volunteer", "contributor", ["fr"], 2],
    ]);
    const pending = await real.service.listSuggestions(SYSTEM, {});
    expect(pending.suggestions.map((s) => [s.key, s.kind, s.value, s.author.name])).toStrictEqual(
      DEMO_SUGGESTIONS.map(({ key, value }, i) => [
        key,
        i === 0 ? "correction" : "translation",
        value,
        DEMO_VOLUNTEER.displayName,
      ]),
    );
  } finally {
    real.close();
  }
});
