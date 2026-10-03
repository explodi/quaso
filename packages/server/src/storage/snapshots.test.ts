// SPDX-License-Identifier: MIT
import { makeTempDir } from "@quaso/runtime/files";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { Command } from "@quaso/runtime/command";
import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals, assertRejects } from "@quaso/runtime/assert";
import { join } from "node:path";
import {
  copyInto,
  fileTimestamp,
  parseFileTimestamp,
  preMigrationName,
  snapshotInWorker,
} from "./snapshots.ts";

/** A WAL database in a temporary folder, with a few rows. */
async function withDatabase(fn: (db: DatabaseSync, dir: string) => Promise<void>) {
  const dir = await makeTempDir();
  const db = new DatabaseSync(join(dir, "quaso.sqlite"));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE strings (id INTEGER PRIMARY KEY, value TEXT)");
    for (const value of ["Play", "Quit", "Options"]) {
      db.prepare("INSERT INTO strings (value) VALUES (?)").run(value);
    }
    await fs.mkdir(join(dir, "backups"));
    await fn(db, dir);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true });
  }
}

function rows(path: string): unknown[] {
  const copy = new DatabaseSync(path);
  try {
    return copy
      .prepare("SELECT value FROM strings ORDER BY id")
      .all()
      .map((row) => row.value);
  } finally {
    copy.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return await fs.stat(path).then(
    () => true,
    () => false,
  );
}

test("snapshots: names carry the UTC time, and read back", () => {
  const time = Date.UTC(2026, 8, 24, 3, 15, 0);
  assertEquals(fileTimestamp(time), "20260924T031500Z");
  assertEquals(parseFileTimestamp("20260924T031500Z"), time);
  assertEquals(preMigrationName(1, 2, time), "pre-migration-v1-to-v2-20260924T031500Z.sqlite");
});

test("snapshots: a complete copy, through a temporary file", async () => {
  await withDatabase(async (db, dir) => {
    const path = join(dir, "backups", "copy.sqlite");
    await copyInto(db, path);
    assertEquals(rows(path), ["Play", "Quit", "Options"]);
    assertEquals(await exists(`${path}.partial`), false);
  });
});

test("snapshots: a worker copies on its own connection, while this one goes on", async () => {
  await withDatabase(async (db, dir) => {
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400000)
      INSERT INTO strings (value) SELECT printf('A longer string, number %d, to copy', i) FROM n`);
    // How long the copy holds this thread when it runs here.
    let started = performance.now();
    await copyInto(db, join(dir, "backups", "here.sqlite"));
    const here = performance.now() - started;

    const path = join(dir, "backups", "copy.sqlite");
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 1);
    try {
      started = performance.now();
      const copying = snapshotInWorker(join(dir, "quaso.sqlite"), path);
      await new Promise((done) => setTimeout(done, 5));
      db.prepare("INSERT INTO strings (value) VALUES (?)").run("Written meanwhile");
      await copying;
    } finally {
      clearInterval(timer);
    }
    const copied = rows(path);
    assertEquals(copied.slice(0, 3), ["Play", "Quit", "Options"]);
    assert(copied.length >= 400_003, String(copied.length));
    assertEquals(await exists(`${path}.partial`), false);
    assert(
      longest < here * 0.6,
      `this thread stalled for ${Math.round(longest)} ms; a copy here takes ${Math.round(here)} ms`,
    );
    await assertRejects(() => snapshotInWorker(join(dir, "missing.sqlite"), path));
  });
});

test("snapshots: work in a standalone Bun subprocess", async () => {
  const dir = await makeTempDir();
  try {
    const probe = join(dir, "probe.ts");
    const snapshots = new URL("./snapshots.ts", import.meta.url).href;
    await fs.writeFile(
      probe,
      `import { DatabaseSync } from "node:sqlite";
       import { copyInto, snapshotInWorker } from "${snapshots}";
       const db = new DatabaseSync(process.argv[2] + "/quaso.sqlite");
       db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2)");
       await copyInto(db, process.argv[2] + "/here.sqlite");
       await snapshotInWorker(process.argv[2] + "/quaso.sqlite", process.argv[2] + "/worker.sqlite");
       for (const name of ["here", "worker"]) {
         const copy = new DatabaseSync(process.argv[2] + "/" + name + ".sqlite");
         console.log(name, copy.prepare("SELECT COUNT(*) AS n FROM t").get()?.n);
       }`,
    );
    const { code, stdout, stderr } = await new Command(process.execPath, {
      args: ["run", probe, dir],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    assertEquals(code, 0, decoder.decode(stderr));
    assertEquals(decoder.decode(stdout), "here 2\nworker 2\n");
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
