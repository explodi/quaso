// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
/** The CLI's build, development and end-to-end scripts. */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { checkBundle, cliVersion, FORBIDDEN, HEADER, packageJson } from "./build_cli.ts";
import { DEV_URL, devArgs, devEnv } from "./cli_dev.ts";
import { parseOptions } from "./cli_e2e.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

test("checkBundle refuses code that could start a process, and imports that aren't node:", () => {
  assertEquals(
    checkBundle(
      'import process from "node:process";\nimport { readFile } from "node:fs/promises";\n' +
        'const text = "to import" + " : ";\nexport { run };\n',
    ),
    [],
  );
  for (const word of FORBIDDEN) {
    assert(checkBundle(`const x = "${word}";`).includes(`contains "${word}"`), word);
  }
  assertEquals(checkBundle('import { x } from "npm:left-pad";'), ['imports "npm:left-pad"']);
  assertEquals(checkBundle('import "./side-effect.js";'), ['imports "./side-effect.js"']);
  assertEquals(checkBundle('const m = await import("fs");'), ['imports "fs"']);
  assertEquals(checkBundle('const m = require("os");'), ['imports "os"']);
  assertEquals(checkBundle("Deno.readTextFile('x');"), ["uses the Deno namespace"]);
});

test("packageJson: one bin, no dependencies, Node 22, the repository when known", () => {
  const pkg = packageJson("@acme/quaso-cli", "1.2.3");
  assertEquals(pkg.name, "@acme/quaso-cli");
  assertEquals(pkg.version, "1.2.3");
  assertEquals(pkg.bin, { quaso: "quaso.mjs" });
  assertEquals(pkg.type, "module");
  assertEquals(pkg.engines, { node: ">=22" });
  assertEquals(pkg.license, "MIT");
  assert(!("dependencies" in pkg));
  assert(!("repository" in pkg));
  assertEquals(packageJson("@acme/quaso-cli", "1.2.3", "acme/quaso").repository, {
    type: "git",
    url: "git+https://github.com/acme/quaso.git",
    directory: "packages/cli",
  });
  assert(HEADER.startsWith("#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\n"));
});

test("the CLI's version matches packages/cli/package.json", async () => {
  const config = JSON.parse(
    await fs.readFile(join(ROOT, "packages", "cli", "package.json"), "utf8"),
  );
  assertEquals(await cliVersion(), config.version);
});

test("deno task cli: the development server and key, unless set", async () => {
  assertEquals(await devEnv({}, () => Promise.resolve("qso_dev")), {
    QUASO_HOSTNAME: DEV_URL,
    QUASO_API_KEY: "qso_dev",
  });
  assertEquals(
    await devEnv({ QUASO_HOSTNAME: "x.test", QUASO_API_KEY: "mine" }, () => Promise.resolve("dev")),
    { QUASO_HOSTNAME: "x.test", QUASO_API_KEY: "mine" },
  );
  assertEquals(await devEnv({}, () => Promise.resolve(null)), { QUASO_HOSTNAME: DEV_URL });
});

test("deno task cli uses the demo when no project is found or chosen", async () => {
  const demo = join(ROOT, "examples", "demo-game");
  const outside = await Deno.makeTempDir();
  try {
    assertEquals(await devArgs(["status"], outside), ["--cwd", demo, "status"]);
    assertEquals(await devArgs(["status", "--cwd", "x"], outside), ["status", "--cwd", "x"]);
    assertEquals(await devArgs(["--config=q.json", "status"], outside), [
      "--config=q.json",
      "status",
    ]);
    assertEquals(await devArgs(["init", "--languages", "de"], outside), [
      "init",
      "--languages",
      "de",
    ]);
    assertEquals(await devArgs(["status"], join(demo, "src")), ["status"]);
  } finally {
    await fs.rm(outside, { recursive: true });
  }
});

test("cli_e2e.ts takes --runtime and --bundle", () => {
  assertEquals(parseOptions(["--runtime", "node"]).runtime, "node");
  assert(
    parseOptions(["--runtime=deno"]).bundle.endsWith(join("packages", "cli", "dist", "quaso.mjs")),
  );
  assertEquals(parseOptions(["--runtime", "deno", "--bundle", "/tmp/q.mjs"]).bundle, "/tmp/q.mjs");
  assertThrows(() => parseOptions([]));
  assertThrows(() => parseOptions(["--runtime", "invalid"]));
  assertThrows(() => parseOptions(["--runtime", "node", "--other"]));
});
