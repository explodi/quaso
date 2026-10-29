// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
/** `deploy/` stays in step with the server: every setting is listed in `.env.example`. */
import { SHUTDOWN_DEADLINE_MS } from "./shutdown.ts";

const read = (path: string) => fs.readFile(new URL(path, import.meta.url), "utf8");

test("deploy: .env.example lists every setting the server reads", async () => {
  const source = await read("./config.ts");
  const names = new Set(
    [...source.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|PORT)"/g)].map((m) => m[1]),
  );
  // Most settings live in the admin panel; this guards against the pattern finding none.
  assert(names.size >= 15, [...names].join(", "));
  const example = await read("../../../deploy/.env.example");
  const listed = new Set([...example.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  expect([...names].filter((name) => !listed.has(name))).toStrictEqual([]);
  expect([...listed].filter((name) => !names.has(name))).toStrictEqual([]);
  const set = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  expect(set).toStrictEqual(["QUASO_DOMAIN", "SETUP_KEY", "TRUST_PROXY"]);
});

test("deploy: the Docker and Compose files carry the licence header", async () => {
  for (const file of ["Dockerfile", "compose.yaml", "Caddyfile", ".env.example"]) {
    const text = await read(`../../../deploy/${file}`);
    expect(text.split("\n")[0], file).toBe("# SPDX-License-Identifier: MIT");
  }
});

test("deploy: Docker waits for a stop longer than the server's own deadline", async () => {
  const compose = await read("../../../deploy/compose.yaml");
  const grace = compose.match(/^ {4}stop_grace_period: (\d+)s$/m);
  assert(grace, "the quaso service sets stop_grace_period");
  assert(Number(grace[1]) * 1000 >= SHUTDOWN_DEADLINE_MS + 10_000, grace[0]);
});
