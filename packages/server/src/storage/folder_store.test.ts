// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_CASES } from "../../../service/src/testing/store_cases.ts";
import { createFolderStore } from "./folder_store.ts";
import { assertEquals, assertInstanceOf } from "@quaso/runtime/assert";
import { StoreConflict } from "@quaso/service";

for (const testCase of STORE_CASES) {
  test(`folder store: ${testCase.name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "quaso-store-"));
    try {
      await testCase.run(createFolderStore(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("folder-store clients share an atomic version check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quaso-store-"));
  try {
    const a = createFolderStore(dir);
    const b = createFolderStore(dir);
    const first = await a.write("object", new Uint8Array([0]));
    const results = await Promise.allSettled([
      a.write("object", new Uint8Array([1]), { ifMatch: first.version }),
      b.write("object", new Uint8Array([2]), { ifMatch: first.version }),
    ]);
    assertEquals(results.filter((result) => result.status === "fulfilled").length, 1);
    assertInstanceOf(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
      StoreConflict,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a process exit before rename leaves the old object and releases the write lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quaso-store-crash-"));
  try {
    const store = createFolderStore(dir);
    const first = await store.write("object", new Uint8Array([1, 2]));
    const module = new URL("./folder_store.ts", import.meta.url).pathname;
    const script = join(dir, "crash.ts");
    await writeFile(
      script,
      `
      import { mock } from "bun:test";
      import * as fs from "node:fs/promises";
      mock.module("node:fs/promises", () => ({ ...fs, rename: () => process.exit(99) }));
      const { createFolderStore } = await import(${JSON.stringify(module)});
      await createFolderStore(${JSON.stringify(dir)}).write("object", new Uint8Array([9, 9]));
    `,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    assertEquals(code, 99, stderr);
    const restarted = createFolderStore(dir);
    assertEquals(await restarted.read("object"), new Uint8Array([1, 2]));
    assertEquals(
      (await readdir(join(dir, "objects"))).filter((name) => name.startsWith(".tmp-")).length,
      1,
    );
    await restarted.write("object", new Uint8Array([3]), { ifMatch: first.version });
    assertEquals(await restarted.read("object"), new Uint8Array([3]));
    assertEquals(
      (await readdir(join(dir, "objects"))).filter((name) => name.startsWith(".tmp-")).length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
