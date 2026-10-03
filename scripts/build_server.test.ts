// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import { compileArgs } from "./build_server.ts";

const BASE = ["build", "--compile", "--asset", "packages/web/dist", "--outfile", "dist/quaso"];
const ENTRIES = ["packages/server/main.ts", "packages/server/src/storage/snapshot_worker.ts"];

test("build_server: compiles main.ts with the website and the worker included", () => {
  assertEquals(compileArgs([]), [...BASE, ...ENTRIES]);
});

test("build_server: passes --target through", () => {
  const target = [...BASE, "--target=bun-linux-x64", ...ENTRIES];
  assertEquals(compileArgs(["--target", "bun-linux-x64"]), target);
  assertEquals(compileArgs(["--target=bun-linux-x64"]), target);
});
