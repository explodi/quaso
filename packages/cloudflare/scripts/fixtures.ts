// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Writes `test/fixtures/demo.json`: the demo project's scenario (`test/scenario.ts`) run
 * with local storage (`node:sqlite`), for the tests in workerd to compare against. With
 * `--check`, fails instead when the file is out of date. Run it with Deno, from the
 * repository's root, with its configuration: deno task cf:fixtures [--check]
 *
 * Line endings don't matter: the demo's files are read with LF, and the check ignores how
 * the fixture's lines end on disk (a Windows checkout has CRLF).
 */
import { openNodeSqlite } from "../../service/src/adapters/node_sqlite.ts";
import { DEMO_IMPORTS, demoDir, readProjectFiles } from "../../server/src/dev_seed.ts";
import { runScenario, type ScenarioInput } from "../test/scenario.ts";
import { fixtureUpToDate, withLf } from "./fixture_text.ts";

const FIXTURE = new URL("../test/fixtures/demo.json", import.meta.url);

/** The demo project as the CLI would send it: the upload, then the imports. */
export async function demoInput(dir = demoDir()): Promise<ScenarioInput> {
  const { config, sources, translations } = await readProjectFiles(dir);
  return {
    upload: {
      files: withLf(sources),
      sourceLanguage: config.sourceLanguage,
      languages: config.languages,
      limits: config.limits,
      pluralExclusions: config.pluralExclusions,
    },
    imports: DEMO_IMPORTS.flatMap(({ language, as }) => {
      const files = translations.get(language);
      return files ? [{ language, files: withLf(files), as, keepIdentical: true }] : [];
    }),
  };
}

if (import.meta.main) {
  const input = await demoInput();
  const database = openNodeSqlite(":memory:");
  let output;
  try {
    output = await runScenario(database.sql, input);
  } finally {
    database.close();
  }
  const text = JSON.stringify({ input, output }, null, 2) + "\n";
  const path = FIXTURE;
  if (process.argv.slice(2).includes("--check")) {
    const current = await fs.readFile(path, "utf8").catch(() => "");
    if (!fixtureUpToDate(current, text)) {
      console.error(`${path.pathname} is out of date: run deno task cf:fixtures`);
      process.exit(1);
    }
    console.log("The workerd fixture is up to date.");
  } else {
    await fs.writeFile(path, text);
    console.log(`Wrote ${path.pathname}`);
  }
}
