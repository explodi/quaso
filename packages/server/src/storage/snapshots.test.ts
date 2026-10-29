// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
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
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
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
  expect(fileTimestamp(time)).toBe("20260924T031500Z");
  expect(parseFileTimestamp("20260924T031500Z")).toStrictEqual(time);
  expect(preMigrationName(1, 2, time)).toStrictEqual(
    "pre-migration-v1-to-v2-20260924T031500Z.sqlite",
  );
});

test("snapshots: a complete copy, through a temporary file", async () => {
  await withDatabase(async (db, dir) => {
    const path = join(dir, "backups", "copy.sqlite");
    await copyInto(db, path);
    expect(rows(path)).toStrictEqual(["Play", "Quit", "Options"]);
    expect(await exists(`${path}.partial`)).toBe(false);
  });
});

/** Writes a row every millisecond until `copying` settles; returns the longest write. */
async function longestWriteDuring(db: DatabaseSync, copying: Promise<void>): Promise<number> {
  const insert = db.prepare("INSERT INTO strings (value) VALUES (?)");
  let longest = 0;
  const timer = setInterval(() => {
    const started = performance.now();
    insert.run("Written meanwhile");
    longest = Math.max(longest, performance.now() - started);
  }, 1);
  try {
    await copying;
  } finally {
    clearInterval(timer);
  }
  return longest;
}

test("snapshots: a worker copies on its own connection, while this one goes on", async () => {
  await withDatabase(async (db, dir) => {
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400000)
      INSERT INTO strings (value) SELECT printf('A longer string, number %d, to copy', i) FROM n`);
    // node:sqlite's backup runs off this thread, but holds this connection: writes wait for it.
    const here = await longestWriteDuring(db, copyInto(db, join(dir, "backups", "here.sqlite")));

    const path = join(dir, "backups", "copy.sqlite");
    const longest = await longestWriteDuring(db, snapshotInWorker(join(dir, "quaso.sqlite"), path));
    const copied = rows(path);
    expect(copied.slice(0, 3)).toStrictEqual(["Play", "Quit", "Options"]);
    assert(copied.length >= 400_003, String(copied.length));
    expect(await exists(`${path}.partial`)).toBe(false);
    assert(
      longest < here * 0.6,
      `a write waited ${Math.round(longest)} ms; ${Math.round(here)} ms with a copy on this connection`,
    );
    await expect(snapshotInWorker(join(dir, "missing.sqlite"), path)).rejects.toThrow();
  });
});

test("snapshots: work in a standalone Node subprocess", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
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
    const { status, stdout, stderr } = spawnSync(process.execPath, [probe, dir], {
      encoding: "utf8",
    });
    expect(status, stderr).toBe(0);
    expect(stdout).toBe("here 2\nworker 2\n");
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
