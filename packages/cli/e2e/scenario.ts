// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The end-to-end scenario (S4.11), for any way of running the CLI: upload, import,
 * download (every language, untranslated strings in English, FMT-2), a second download
 * that writes nothing (acceptance test 5), Polish plural keys (acceptance test 8),
 * `status --fail-on`, `--prune`, and the exit codes for an invalid source file (5), a
 * missing or wrong key (3) and a server that isn't running (4). The English files' hashes
 * don't change (acceptance test 6). Then LLM translation against a server with the fake
 * translator (S5.6): `upload --wait`, `translate` with `--dry-run`, `--language`, `--file`
 * and `--no-wait`, and exit code 6 with the failed strings' local paths.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@quaso/runtime/assert";
import { join } from "node:path";
import {
  closedAddress,
  copyDemo,
  DEMO_FILES,
  DEMO_LANGUAGES,
  hashFiles,
  jsonOf,
  type Runner,
  startServer,
  tempDir,
} from "./harness.ts";

/** Runs the scenario; `log` reports each step. */
export async function runScenario(cli: Runner, log: (step: string) => void = () => {}) {
  const server = await startServer();
  const temp = await tempDir("quaso-cli-e2e-");
  try {
    const project = await copyDemo(temp.dir);
    const english = join(project, "src", "locales", "en");
    const before = await hashFiles(english);
    const env = { QUASO_HOSTNAME: server.url, QUASO_API_KEY: server.uploadKey };
    const quaso = async (args: string[], expected: number, extra: Record<string, string> = {}) => {
      const result = await cli(args, { cwd: project, env: { ...env, ...extra } });
      assertEquals(
        result.code,
        expected,
        `quaso ${args.join(" ")} exited with ${result.code}, not ${expected}\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      return result;
    };

    log("upload");
    const first = await quaso(["upload"], 0);
    assertStringIncludes(first.stdout, "3 files uploaded");
    assertStringIncludes(
      first.stdout,
      "Languages added on the instance: de, fr, pl, ja, ar, pt-BR",
    );

    log("upload again: nothing changes");
    const again = jsonOf(await quaso(["upload", "--json"], 0));
    assertEquals(again.schemaVersion, 1);
    assertEquals(again.command, "upload");
    assertEquals(again.result.uploadId, null);
    assert(again.result.files.every((file: { status: string }) => file.status === "unchanged"));

    log("import the demo's German as blue and Polish as green");
    const german = jsonOf(
      await quaso(["import", "--as", "blue", "--language", "de", "--keep-identical", "--json"], 0),
    );
    assert(german.result.languages[0].imported > 0, JSON.stringify(german.result));
    await quaso(["import", "--as", "green", "--language", "pl", "--keep-identical"], 0);

    log("status shows German as blue; --fail-on untranslated exits 7");
    const status = jsonOf(await quaso(["status", "--language", "de", "--json"], 0));
    const de = status.result.languages[0];
    assertEquals(de.tag, "de");
    assert(de.blue > 0 && de.blue === de.strings - de.untranslated, JSON.stringify(de));
    const failing = await quaso(["status", "--fail-on", "untranslated"], 7);
    assertStringIncludes(failing.stdout, "--fail-on untranslated: met");
    assertStringIncludes(failing.stdout, "ja: ");
    await quaso(["status", "--fail-on", "untranslated", "--language", "de"], 0);

    log("download writes every language");
    const download = jsonOf(await quaso(["download", "--json"], 0));
    assertEquals(download.result.skipped, []);
    for (const language of DEMO_LANGUAGES) {
      for (const file of DEMO_FILES) {
        const path = join(project, "src", "locales", language, file);
        assert((await fs.stat(path)).isFile(), `${language}/${file} was written`);
      }
    }
    const japanese = JSON.parse(
      await fs.readFile(join(project, "src", "locales", "ja", "common.json"), "utf8"),
    );
    assertEquals(japanese.play, "Play", "untranslated strings are written in English (FMT-2)");

    log("a second download writes nothing (acceptance test 5)");
    const second = jsonOf(await quaso(["download", "--json"], 0));
    assertEquals(second.result.written, []);
    assertEquals(second.result.unchanged.length, DEMO_LANGUAGES.length * DEMO_FILES.length);
    const quiet = await quaso(["download"], 0);
    assertStringIncludes(quiet.stdout, "Everything is up to date");

    log("the Polish file has every plural form (acceptance test 8)");
    const polish = JSON.parse(
      await fs.readFile(join(project, "src", "locales", "pl", "common.json"), "utf8"),
    );
    for (const key of ["coins_one", "coins_few", "coins_many", "coins_other"]) {
      assert(key in polish, `pl/common.json has ${key}`);
    }

    log("download --prune deletes only orphaned translation files");
    const orphan = join(project, "src", "locales", "de", "old.json");
    const notes = join(project, "src", "locales", "de", "notes.txt");
    await fs.writeFile(orphan, "{}\n");
    await fs.writeFile(notes, "not a translation\n");
    const dry = jsonOf(await quaso(["download", "--prune", "--dry-run", "--json"], 0));
    assertEquals(dry.result.pruned, [{ path: "src/locales/de/old.json", language: "de" }]);
    assert((await fs.stat(orphan)).isFile(), "a dry run deletes nothing");
    await quaso(["download", "--prune"], 0);
    await fs.stat(orphan).then(
      () => assert(false, "old.json was pruned"),
      (error) => assert((error as NodeJS.ErrnoException).code === "ENOENT"),
    );
    assert((await fs.stat(notes)).isFile(), "files the pattern can't produce stay");

    log("a missing key exits 3, a wrong key exits 3");
    const missing = await quaso(["status"], 3, { QUASO_API_KEY: "" });
    assertStringIncludes(missing.stderr, "QUASO_API_KEY");
    await quaso(["status"], 3, { QUASO_API_KEY: "qso_not-a-real-key" });
    const readOnly = await quaso(["upload"], 3, { QUASO_API_KEY: server.readKey });
    assertStringIncludes(readOnly.stderr, "scope");

    log("a server that isn't running exits 4");
    const down = await quaso(["status", "--json"], 4, { QUASO_HOSTNAME: closedAddress() });
    assertEquals(jsonOf(down).error.code, "network");

    log("the English files are unchanged (acceptance test 6)");
    assertEquals(await hashFiles(english), before);

    log("an invalid source file exits 5 with its file, line and column");
    const broken = await copyDemo(temp.dir, "broken");
    await fs.writeFile(
      join(broken, "src", "locales", "en", "menus.json"),
      '{\n  "main": {\n    "play": "Play",\n  }\n}\n',
    );
    const invalid = await cli(["upload", "--dry-run"], { cwd: broken, env });
    assertEquals(invalid.code, 5, `${invalid.stdout}\n${invalid.stderr}`);
    assertMatch(invalid.stderr, /src\/locales\/en\/menus\.json:3:19: /);

    await llmScenario(cli, temp.dir, log);
  } finally {
    await server.close();
    await temp.remove();
  }
}

/**
 * LLM translation with the fake translator: an upload's automatic job, then
 * `quaso translate`. A length limit the fake translator can't meet makes one string fail.
 */
async function llmScenario(cli: Runner, parent: string, log: (step: string) => void) {
  const server = await startServer({ llm: true });
  try {
    const project = await copyDemo(parent, "llm");
    const configPath = join(project, "quaso.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const limits = config.limits;
    const writeConfig = (extra: unknown[]) =>
      fs.writeFile(
        configPath,
        `${JSON.stringify({ ...config, limits: [...limits, ...extra] }, null, 2)}\n`,
      );
    // "Welcome back, {{name}}!" can't fit in 5 characters: {{name}} alone has 8.
    await writeConfig([{ file: "common.json", key: "greeting", maxLength: 5 }]);
    const env = { QUASO_HOSTNAME: server.url, QUASO_API_KEY: server.uploadKey };
    const quaso = async (args: string[], expected: number) => {
      const result = await cli(args, { cwd: project, env });
      assertEquals(
        result.code,
        expected,
        `quaso ${args.join(" ")} exited with ${result.code}, not ${expected}\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      return result;
    };

    log("LLM: upload --wait waits for the automatic job; a string that fails exits 6");
    const uploaded = await quaso(["upload", "--wait"], 6);
    assertStringIncludes(uploaded.stdout, "3 files uploaded");
    for (const language of DEMO_LANGUAGES) {
      assertStringIncludes(
        uploaded.stdout,
        `src/locales/${language}/common.json › greeting (${language}): at most 5 characters`,
      );
    }
    const status = jsonOf(await quaso(["status", "--json"], 0));
    for (const language of status.result.languages) {
      assertEquals(language.untranslated, 1, `${language.tag}: only the greeting`);
      assertEquals(language.green, language.strings - 1);
    }

    log("LLM: translate --dry-run estimates, translate --language fails again (exit 6)");
    const dry = jsonOf(await quaso(["translate", "--dry-run", "--json"], 0));
    assertEquals(dry.result.estimate.strings, DEMO_LANGUAGES.length);
    assertEquals(dry.result.estimate.requests, DEMO_LANGUAGES.length);
    assert(dry.result.estimate.estimatedTokens.input > 0);
    const failing = jsonOf(await quaso(["translate", "--language", "pl", "--json"], 6));
    assertEquals(
      failing.result.failures.map((f: { file: string }) => f.file),
      ["src/locales/pl/common.json"],
    );

    log("LLM: without the limit, translate --file translates it, and download writes it");
    await writeConfig([]);
    await quaso(["upload"], 0);
    const translated = jsonOf(
      await quaso(["translate", "--file", "src/locales/en/common.json", "--json"], 0),
    );
    assertEquals(translated.result.job.progress.translated, DEMO_LANGUAGES.length);
    assertEquals(translated.result.failures, []);
    await quaso(["download"], 0);
    const polish = JSON.parse(
      await fs.readFile(join(project, "src", "locales", "pl", "common.json"), "utf8"),
    );
    assertEquals(polish.greeting, "[Ŵéļçöɱé ƀáçķ, {{name}}!]");
    assertEquals(polish.coins_few, "[{{count}} çöíñś]");
    const menus = JSON.parse(
      await fs.readFile(join(project, "src", "locales", "de", "menus.json"), "utf8"),
    );
    assertEquals(menus.main.playAgain, "[$t(common:play) áğáíñ]", "the reference stays");

    log("LLM: translate --retranslate --no-wait starts a job and exits");
    const queued = jsonOf(await quaso(["translate", "--retranslate", "--no-wait", "--json"], 0));
    assertEquals(queued.result.waited, false);
    assert(queued.result.job.id > 0);
  } finally {
    await server.close();
  }
}
