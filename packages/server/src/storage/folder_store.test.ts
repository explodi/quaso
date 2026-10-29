// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { STORE_CASES } from "../../../service/src/testing/store_cases.ts";
import { createFolderStore } from "./folder_store.ts";
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
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    assert(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult)
        .reason instanceof StoreConflict,
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
    // The resolve hook gives folder_store.ts, and only it, a rename that exits the process.
    const crashingFs = join(dir, "crashing_fs.ts");
    await writeFile(
      crashingFs,
      `export * from "node:fs/promises";\nexport const rename = () => process.exit(99);\n`,
    );
    const hooks = join(dir, "hooks.ts");
    await writeFile(
      hooks,
      `
      import { registerHooks } from "node:module";
      import { pathToFileURL } from "node:url";
      registerHooks({
        resolve(specifier, context, next) {
          const fromStore = context.parentURL === ${JSON.stringify(module)};
          if (fromStore && specifier === "node:fs/promises") {
            return { url: pathToFileURL(${JSON.stringify(crashingFs)}).href, shortCircuit: true };
          }
          return next(specifier, context);
        },
      });
    `,
    );
    const { status, stderr } = spawnSync(process.execPath, ["--import", hooks, script], {
      encoding: "utf8",
    });
    expect(status, stderr).toBe(99);
    const restarted = createFolderStore(dir);
    expect(await restarted.read("object")).toStrictEqual(new Uint8Array([1, 2]));
    expect(
      (await readdir(join(dir, "objects"))).filter((name) => name.startsWith(".tmp-")).length,
    ).toBe(1);
    await restarted.write("object", new Uint8Array([3]), { ifMatch: first.version });
    expect(await restarted.read("object")).toStrictEqual(new Uint8Array([3]));
    expect(
      (await readdir(join(dir, "objects"))).filter((name) => name.startsWith(".tmp-")).length,
    ).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
