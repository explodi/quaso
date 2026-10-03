// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertMatch } from "@quaso/runtime/assert";
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
  assertEquals(globBase("src/locales/en/**/*.json"), "src/locales/en");
  assertEquals(globBase("locales/en/*.json"), "locales/en");
  assertEquals(globBase("en/common.json"), "en");
  assertEquals(globBase("*.json"), "");
});

test("seed: the demo project's files, read as the CLI would", async () => {
  const { config, sources, translations } = await readProjectFiles(demoDir());
  assertEquals(config.sourceLanguage, "en");
  assertEquals(config.languages, ["de", "fr", "pl", "ja", "ar", "pt-BR"]);
  assertEquals(config.limits, [{ file: "store.json", key: "title", maxLength: 30 }]);
  assertEquals(
    sources.map((file) => file.path),
    ["common.json", "menus.json", "store.json"],
  );
  const found = [...translations].map(([language, files]) => [language, files.map((f) => f.path)]);
  assertEquals(found, [
    ["de", ["common.json", "menus.json", "store.json"]],
    ["fr", ["common.json", "menus.json"]],
    ["pl", ["common.json", "menus.json", "store.json"]],
  ]);
});

test("seed: the demo project, partly translated, with a development key", {}, async () => {
  const real = await realService({ dev: true });
  try {
    const { apiKey, imports } = await seedDemo(real.service, demoDir(), { people: true });
    assertMatch(apiKey, /^qso_/);
    for (const result of imports) {
      assertEquals(result.refused, [], result.language);
      assertEquals(result.unknownKeys, [], result.language);
      assertEquals(result.unknownFiles, [], result.language);
    }
    const status = await real.service.getStatus(SYSTEM, {});
    const counts = Object.fromEntries(
      status.languages.map((l) => [l.tag, [l.strings, l.untranslated, l.green, l.blue]]),
    );
    assertEquals(counts.de, [40, 0, 0, 40]);
    assertEquals(counts.pl, [40, 0, 40, 0]);
    assertEquals(counts.fr[3], 0);
    assertEquals(counts.fr[1] > 0 && counts.fr[2] > 0, true);
    for (const tag of ["ja", "ar", "pt-BR"]) assertEquals(counts[tag], [40, 40, 0, 0]);

    const { app } = testApp(real.service);
    const upload = await call(app, "/api/v1/sources", {
      method: "POST",
      key: apiKey,
      json: { files: (await readProjectFiles(demoDir())).sources, dryRun: true },
    });
    assertEquals(upload.status, 200);
    assertEquals((await upload.json()).dryRun, true);

    // The developer account (an administrator), and the demo volunteer's suggestions.
    const developer = await real.service.ensureDevAccount(SYSTEM, {});
    assertEquals([developer.displayName, developer.role], ["Developer", "administrator"]);
    const members = await real.service.listMembers(SYSTEM, {});
    assertEquals(
      members.members.map((m) => [m.displayName, m.role, m.languages, m.contributions]),
      [
        ["Developer", "administrator", null, 0],
        ["Demo Volunteer", "contributor", ["fr"], 2],
      ],
    );
    const pending = await real.service.listSuggestions(SYSTEM, {});
    assertEquals(
      pending.suggestions.map((s) => [s.key, s.kind, s.value, s.author.name]),
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
