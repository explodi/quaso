// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
/** The CLI's build, development and end-to-end scripts. */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBundle, FORBIDDEN, HEADER, packageJson } from "./build_cli.ts";
import { DEV_URL, devArgs, devEnv } from "./cli_dev.ts";
import { parseOptions } from "./cli_e2e.ts";
import { demoDir } from "../packages/server/src/dev_seed.ts";

test("checkBundle refuses code that could start a process, and imports that aren't node:", () => {
  expect(
    checkBundle(
      'import process from "node:process";\nimport { readFile } from "node:fs/promises";\n' +
        'const text = "to import" + " : ";\nexport { run };\n',
    ),
  ).toStrictEqual([]);
  for (const word of FORBIDDEN) {
    assert(checkBundle(`const x = "${word}";`).includes(`contains "${word}"`), word);
  }
  expect(checkBundle('import { x } from "npm:left-pad";')).toStrictEqual([
    'imports "npm:left-pad"',
  ]);
  expect(checkBundle('import "./side-effect.js";')).toStrictEqual(['imports "./side-effect.js"']);
  expect(checkBundle('const m = await import("fs");')).toStrictEqual(['imports "fs"']);
  expect(checkBundle('const m = require("os");')).toStrictEqual(['imports "os"']);
});

test("packageJson: one bin, no dependencies, Node 22, the repository when known", () => {
  const pkg = packageJson("@acme/quaso-cli", "1.2.3");
  expect(pkg.name).toBe("@acme/quaso-cli");
  expect(pkg.version).toBe("1.2.3");
  expect(pkg.bin).toStrictEqual({ quaso: "quaso.mjs" });
  expect(pkg.type).toBe("module");
  expect(pkg.engines).toStrictEqual({ node: ">=22" });
  expect(pkg.license).toBe("MIT");
  assert(!("dependencies" in pkg));
  assert(!("repository" in pkg));
  expect(packageJson("@acme/quaso-cli", "1.2.3", "acme/quaso").repository).toStrictEqual({
    type: "git",
    url: "git+https://github.com/acme/quaso.git",
    directory: "packages/cli",
  });
  assert(HEADER.startsWith("#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\n"));
});

test("npm run cli: the development server and key, unless set", async () => {
  expect(await devEnv({}, () => Promise.resolve("qso_dev"))).toStrictEqual({
    QUASO_HOSTNAME: DEV_URL,
    QUASO_API_KEY: "qso_dev",
  });
  expect(
    await devEnv({ QUASO_HOSTNAME: "x.test", QUASO_API_KEY: "mine" }, () => Promise.resolve("dev")),
  ).toStrictEqual({ QUASO_HOSTNAME: "x.test", QUASO_API_KEY: "mine" });
  expect(await devEnv({}, () => Promise.resolve(null))).toStrictEqual({ QUASO_HOSTNAME: DEV_URL });
});

test("npm run cli uses the demo when no project is found or chosen", async () => {
  const demo = demoDir();
  const outside = await fs.mkdtemp(join(tmpdir(), "quaso-cli-dev-"));
  try {
    expect(await devArgs(["status"], outside)).toStrictEqual(["--cwd", demo, "status"]);
    expect(await devArgs(["status", "--cwd", "x"], outside)).toStrictEqual([
      "status",
      "--cwd",
      "x",
    ]);
    expect(await devArgs(["--config=q.json", "status"], outside)).toStrictEqual([
      "--config=q.json",
      "status",
    ]);
    expect(await devArgs(["init", "--languages", "de"], outside)).toStrictEqual([
      "init",
      "--languages",
      "de",
    ]);
    expect(await devArgs(["status"], join(demo, "src"))).toStrictEqual(["status"]);
  } finally {
    await fs.rm(outside, { recursive: true });
  }
});

test("cli_e2e.ts takes --bundle", () => {
  assert(parseOptions([]).bundle.endsWith(join("packages", "cli", "dist", "quaso.mjs")));
  expect(parseOptions(["--bundle", "/tmp/q.mjs"]).bundle).toBe("/tmp/q.mjs");
  expect(parseOptions(["--bundle=/tmp/q.mjs"]).bundle).toBe("/tmp/q.mjs");
  expect(() => parseOptions(["--bundle"])).toThrow();
  expect(() => parseOptions(["--runtime", "node"])).toThrow();
  expect(parseOptions([]).node).toBe(process.execPath);
  expect(parseOptions(["--node", "/opt/node22/bin/node"]).node).toBe("/opt/node22/bin/node");
});
