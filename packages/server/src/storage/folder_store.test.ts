// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_CASES } from "../../../service/src/testing/store_cases.ts";
import { createFolderStore } from "./folder_store.ts";
import { assertEquals, assertInstanceOf } from "@std/assert";
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
    const module = new URL("./folder_store.ts", import.meta.url).href;
    const script = join(dir, "crash.ts");
    await writeFile(
      script,
      `
      import { createFolderStore } from ${JSON.stringify(module)};
      await createFolderStore(${JSON.stringify(dir)}).write("object", new Uint8Array([9, 9]));
    `,
    );
    // The import map gives folder_store.ts, and only it, a rename that exits the process.
    const crashingFs = join(dir, "crashing_fs.ts");
    await writeFile(
      crashingFs,
      `export * from "node:fs/promises";\nexport const rename = () => Deno.exit(99);\n`,
    );
    const importMap = join(dir, "import_map.json");
    await writeFile(
      importMap,
      JSON.stringify({
        imports: { "@quaso/core": new URL("../../../core/mod.ts", import.meta.url).href },
        scopes: { [module]: { "node:fs/promises": crashingFs } },
      }),
    );
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", `--import-map=${importMap}`, script],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(code, 99, new TextDecoder().decode(stderr));
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
