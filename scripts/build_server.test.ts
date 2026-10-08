// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { compileArgs } from "./build_server.ts";

const BASE = [
  "compile",
  "-A",
  "--node-modules-dir=none",
  "--exclude-unused-npm",
  "--include",
  "packages/web/dist",
  "--include",
  "packages/server/src/storage/snapshot_worker.ts",
  "--output",
  "dist/quaso",
];
const ENTRY = "packages/server/main.ts";

test("build_server: compiles main.ts with the website and the worker included", () => {
  assertEquals(compileArgs([]), [...BASE, ENTRY]);
});

test("build_server: passes --target through", () => {
  const target = [...BASE, "--target=x86_64-unknown-linux-gnu", ENTRY];
  assertEquals(compileArgs(["--target", "x86_64-unknown-linux-gnu"]), target);
  assertEquals(compileArgs(["--target=x86_64-unknown-linux-gnu"]), target);
});
