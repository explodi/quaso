// SPDX-License-Identifier: MIT
/**
 * `quaso convert-to-icu` against the real server and service: the instance and the source
 * files convert alike, so an upload afterwards changes nothing and a download writes ICU.
 */
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type Service, SYSTEM, silentLogger } from "@quaso/service";
import { createMemoryStore } from "../../service/src/adapters/memory_store.ts";
import { openAsyncSqlite } from "../../service/src/adapters/node_async_sqlite.ts";
import { createAsyncService } from "../../service/src/service_async.ts";
import { runCli, withProject } from "../../cli/src/test_helpers.ts";
import { type App, createApp } from "./app.ts";
import { call, testConfig } from "./testing/helpers.ts";

const CONFIG = {
  sourceLanguage: "en",
  languages: ["de"],
  files: [
    { source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" },
    { source: "docs/en/**/*.md", translation: "docs/{lang}/{path}" },
  ],
};

const ENGLISH = {
  greeting: "Hello {{name}}",
  hint: "Press {Enter} to start",
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  back: "Back",
};

const GERMAN = {
  greeting: "Hallo {{name}}",
  hint: "Drück {Enter} zum Starten",
  coins_one: "{{count}} Münze",
  coins_other: "{{count}} Münzen",
  back: "Zurück",
};

const NEWS = "# {{city}} is founded\n\nIt's {big} news.\n";

const CONVERTED = [
  "{",
  '  "greeting": "Hello {name}",',
  "  \"hint\": \"Press '{'Enter'}' to start\",",
  '  "coins": "{count, plural, one {{count} coin} other {{count} coins}}",',
  '  "back": "Back"',
  "}",
  "",
].join("\n");

const CONVERTED_NEWS = "# {city} is founded\n\nIt's '{'big'}' news.\n";

const PROJECT = {
  "quaso.config.json": CONFIG,
  "src/locales/en/common.json": ENGLISH,
  "docs/en/news.md": NEWS,
};

/**
 * Runs `fn` with a project folder, an instance that publishes files, and the CLI with an
 * upload key. `later` moves the clock past the publication's quiet time and runs its alarm.
 */
async function withInstance(
  files: Record<string, string | object>,
  fn: (setup: {
    dir: string;
    service: Service;
    app: App;
    cli: (args: string[], key?: string) => ReturnType<typeof runCli>;
    read: (path: string) => Promise<string>;
    later: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const opened = openAsyncSqlite(":memory:");
  let now = Date.UTC(2026, 9, 1);
  try {
    const service = createAsyncService({
      sql: opened.sql,
      store: createMemoryStore(),
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
      clock: () => now,
    });
    await service.start();
    const upload = await service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
    const app = createApp({ config: testConfig(), service, log: silentLogger });
    const later = async () => {
      now += 60_000;
      await service.alarm();
    };
    await withProject(files, async (dir) => {
      const cli = (args: string[], key = upload.secret) =>
        runCli(args, {
          cwd: dir,
          env: { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: key },
          fetch: (input: RequestInfo | URL, init?: RequestInit) => app(new Request(input, init)),
        });
      const read = (path: string) => fs.readFile(join(dir, ...path.split("/")), "utf8");
      await fn({ dir, service, app, cli, read, later });
    });
  } finally {
    opened.close();
  }
}

test("convert-to-icu: the files convert as the instance does, so upload changes nothing and download writes ICU", async () => {
  await withInstance(PROJECT, async ({ service, cli, read }) => {
    assertEquals((await cli(["upload"])).code, 0);
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      files: [{ path: "common.json", content: JSON.stringify(GERMAN) }],
    });

    const converted = await cli(["convert-to-icu"]);
    assertEquals(converted.code, 0, converted.stderr);
    assertStringIncludes(converted.stdout, "Converted to ICU MessageFormat");
    assertEquals(await read("src/locales/en/common.json"), CONVERTED);
    assertEquals(await read("docs/en/news.md"), CONVERTED_NEWS);

    const upload = await cli(["upload", "--dry-run", "--json"]);
    const compared = JSON.parse(upload.stdout).result;
    assertEquals(
      compared.files.map((file: { path: string; status: string }) => [file.path, file.status]),
      [
        ["common.json", "unchanged"],
        ["news.md", "unchanged"],
      ],
    );

    assertEquals((await cli(["download"])).code, 0);
    assertEquals(
      await read("src/locales/de/common.json"),
      [
        "{",
        '  "greeting": "Hallo {name}",',
        "  \"hint\": \"Drück '{'Enter'}' zum Starten\",",
        '  "coins": "{count, plural, one {{count} Münze} other {{count} Münzen}}",',
        '  "back": "Zurück"',
        "}",
        "",
      ].join("\n"),
    );

    const again = await cli(["convert-to-icu"]);
    assertEquals(again.code, 0);
    assertStringIncludes(again.stdout, "Nothing to do");
  });
});

test("convert-to-icu: the files the instance publishes are ICU after its next publication", async () => {
  await withInstance(PROJECT, async ({ service, app, cli, later }) => {
    assertEquals((await cli(["upload"])).code, 0);
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      files: [{ path: "common.json", content: JSON.stringify(GERMAN) }],
    });
    await later();
    assertEquals((await cli(["convert-to-icu"])).code, 0);
    await later();
    const published = await call(app, "/files/de/common.json");
    assertEquals(JSON.parse(await published.text()).greeting, "Hallo {name}");
  });
});

test("convert-to-icu converts the files of a project the instance converted before", async () => {
  await withInstance(PROJECT, async ({ service, cli, read }) => {
    assertEquals((await cli(["upload"])).code, 0);
    await service.convertToIcu(SYSTEM, {});
    const finished = await cli(["convert-to-icu"]);
    assertEquals(finished.code, 0, finished.stderr);
    assertStringIncludes(finished.stdout, "Converted the source files to match the instance");
    assertEquals(await read("src/locales/en/common.json"), CONVERTED);
    assertEquals(await read("docs/en/news.md"), CONVERTED_NEWS);
  });
});

test("convert-to-icu --dry-run reports both sides and writes nothing", async () => {
  await withInstance(PROJECT, async ({ service, cli, read }) => {
    assertEquals((await cli(["upload"])).code, 0);
    const preview = await cli(["convert-to-icu", "--dry-run", "--json"]);
    assertEquals(preview.code, 0, preview.stderr);
    const report = JSON.parse(preview.stdout).result;
    assertEquals([report.dryRun, report.converted, report.instance.strings], [true, false, 4]);
    assertEquals(report.files, [
      { file: "src/locales/en/common.json", changed: true, merged: ["coins"], escapes: 2 },
      { file: "docs/en/news.md", changed: true, merged: [], escapes: 2 },
    ]);
    assertEquals(await read("src/locales/en/common.json"), `${JSON.stringify(ENGLISH, null, 2)}\n`);
    assertEquals((await service.getProject(SYSTEM, {})).syntax.icu, false);
  });
});

test("convert-to-icu refuses texts ICU can't say, and changes nothing", async () => {
  const files = {
    ...PROJECT,
    "src/locales/en/common.json": { ...ENGLISH, title: "$t(back) and {{price, number}}" },
  };
  await withInstance(files, async ({ service, cli, read }) => {
    assertEquals((await cli(["upload"])).code, 0);
    const refused = await cli(["convert-to-icu"]);
    assertEquals(refused.code, 6);
    assertStringIncludes(
      refused.stdout,
      "src/locales/en/common.json › title: $t(back) is an i18next",
    );
    assertStringIncludes(refused.stdout, "Nothing was converted.");
    assertEquals(
      await read("src/locales/en/common.json"),
      `${JSON.stringify(files["src/locales/en/common.json"], null, 2)}\n`,
    );
    assertEquals((await service.getProject(SYSTEM, {})).syntax.icu, false);
  });
});

test("convert-to-icu refuses source files that differ from the instance's", async () => {
  await withInstance(PROJECT, async ({ dir, cli }) => {
    assertEquals((await cli(["upload"])).code, 0);
    await fs.writeFile(join(dir, "src/locales/en/common.json"), '{"greeting": "Hi {{name}}"}');
    const refused = await cli(["convert-to-icu"]);
    assertEquals(refused.code, 2);
    assertStringIncludes(refused.stderr, "The source files differ from the instance's.");
  });
});

test("convert-to-icu with a read key says which key it needs", async () => {
  await withInstance(PROJECT, async ({ service, cli }) => {
    assertEquals((await cli(["upload"])).code, 0);
    const read = await service.createApiToken(SYSTEM, { name: "Reader", scope: "read" });
    const refused = await cli(["convert-to-icu"], read.secret);
    assertEquals(refused.code, 3);
    assertStringIncludes(
      refused.stderr,
      "an API key with the upload scope that an administrator created",
    );
  });
});
