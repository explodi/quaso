// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
/**
 * Acceptance test 6 (S4.10, CLI-5): every command, with and without `--json`, against a real
 * server in a temporary copy of the demo, and the English files' SHA-256 are the same
 * afterwards. With `--json`, stdout is exactly one JSON document every time.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { copyDemo, hashFiles, inProcess, jsonOf, startServer, tempDir } from "./harness.ts";

test("every command leaves the English files as they were (acceptance test 6)", async () => {
  const server = await startServer();
  const temp = await tempDir("quaso-cli-safety-");
  try {
    const project = await copyDemo(temp.dir);
    const english = join(project, "src", "locales", "en");
    const before = await hashFiles(english);
    const cli = inProcess();
    const env = { QUASO_HOSTNAME: server.url, QUASO_API_KEY: server.uploadKey };

    const empty = join(temp.dir, "empty");
    await fs.mkdir(empty);
    const emptyJson = join(temp.dir, "empty-json");
    await fs.mkdir(emptyJson);

    const commands: { args: string[]; cwd?: string; code?: number }[] = [
      { args: ["init", "--languages", "de,fr"], cwd: empty },
      { args: ["init", "--languages", "de,fr"], cwd: project, code: 2 },
      { args: ["upload", "--dry-run"] },
      { args: ["upload"] },
      { args: ["import", "--as", "green", "--dry-run"] },
      { args: ["import", "--as", "blue", "--language", "de"] },
      { args: ["import", "--as", "green", "--language", "fr,pl"] },
      { args: ["status"] },
      { args: ["status", "--fail-on", "untranslated"], code: 7 },
      { args: ["download", "--dry-run"] },
      { args: ["download", "--overwrite-local"] },
      { args: ["download", "--prune", "--dry-run"] },
      { args: ["download", "--prune"] },
      { args: ["upload", "--file", "common.json"] },
      { args: ["download", "--language", "en"], code: 2 },
      { args: ["version"] },
      { args: ["help"] },
    ];
    for (const json of [false, true]) {
      for (const command of commands) {
        const args = json ? [...command.args, "--json"] : command.args;
        const cwd = command.cwd === empty && json ? emptyJson : (command.cwd ?? project);
        const result = await cli(args, { cwd, env });
        assertEquals(
          result.code,
          command.code ?? 0,
          `quaso ${args.join(" ")}:\n${result.stdout}\n${result.stderr}`,
        );
        if (json) {
          const document = jsonOf(result);
          assertEquals(document.schemaVersion, 1);
          assertEquals(document.exitCode, result.code);
        } else {
          assert(
            !result.stdout.trimStart().startsWith("{"),
            `quaso ${args.join(" ")} printed text`,
          );
        }
      }
    }
    assertEquals(await hashFiles(english), before);
    assert((await fs.stat(join(empty, "quaso.config.json"))).isFile());
  } finally {
    await server.close();
    await temp.remove();
  }
});
