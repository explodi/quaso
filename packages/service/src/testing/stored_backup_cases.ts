// SPDX-License-Identifier: MIT
import { DAY_MS } from "../file_retention.ts";
import type { Store } from "../ports.ts";
import {
  backupKey,
  createStoredBackups,
  DEFAULT_BACKUP_DAYS,
  HOUR_MS,
  listStoredBackups,
  pruneStoredBackups,
} from "../stored_backups.ts";
import { StoreConflict } from "../store.ts";
import { check, checkEqual } from "./assert.ts";

const NOW = Date.UTC(2026, 9, 31, 12);
const BYTES = new Uint8Array([1, 2, 3]);
async function fail(run: () => Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  check(error instanceof Error);
}
async function keys(store: Store) {
  const found: string[] = [];
  for await (const object of store.list("")) found.push(object.key);
  return found;
}
function setup(store: Store) {
  const time = { now: NOW };
  const calls: (number | null)[] = [];
  const captures = { count: 0 };
  const options = {
    extension: "sqlite" as const,
    clock: () => time.now,
    capture: async () => {
      captures.count++;
      return BYTES;
    },
    scheduler: {
      schedule: (at: number) => {
        calls.push(at);
      },
      cancel: () => {
        calls.push(null);
      },
    },
  };
  return { backups: createStoredBackups(store, options), options, time, calls, captures };
}

export const STORED_BACKUP_CASES: { name: string; run(store: Store): Promise<void> }[] = [
  {
    name: "a failed alarm schedules another attempt and preserves existing recovery copies",
    async run(store) {
      const old = backupKey(NOW - 31 * DAY_MS, "sqlite");
      await store.write(old, BYTES);
      const { options, time, calls } = setup(store);
      let offline = true;
      const backups = createStoredBackups(store, {
        ...options,
        async capture() {
          if (offline) {
            offline = false;
            throw new Error("offline");
          }
          return BYTES;
        },
      });
      await backups.start();
      time.now += 60_000;
      await fail(() => backups.alarm());
      checkEqual(backups.busy, false);
      checkEqual(await store.read(old), BYTES);
      checkEqual(calls, [NOW + 60_000, time.now + HOUR_MS]);
      time.now += HOUR_MS;
      await backups.alarm();
      checkEqual(await store.read(backupKey(time.now, "sqlite")), BYTES);
      checkEqual(await store.read(old), null);
    },
  },
  {
    name: "retention keeps every recent copy and the newest copy of each older UTC day",
    async run(store) {
      const recent = backupKey(NOW - HOUR_MS, "sqlite");
      const boundary = backupKey(NOW - 48 * HOUR_MS, "sqlite");
      const older = backupKey(NOW - 3 * DAY_MS, "sqlite");
      const newest = backupKey(NOW - 3 * DAY_MS + HOUR_MS, "sqlite");
      const cutoff = backupKey(NOW - DEFAULT_BACKUP_DAYS * DAY_MS, "sqlite");
      const expired = backupKey(NOW - DEFAULT_BACKUP_DAYS * DAY_MS - 1000, "sqlite");
      const migration = "backups/pre-migration-v1-to-v2-20260101T000000Z.sqlite";
      const unknown = "backups/quaso-20260230T000000Z.sqlite";
      const published = "published/de/menu.json";
      await store.write(recent, BYTES);
      await store.write(boundary, BYTES);
      await store.write(older, BYTES);
      await store.write(newest, BYTES);
      await store.write(cutoff, BYTES);
      await store.write(expired, BYTES);
      await store.write(migration, BYTES);
      await store.write(unknown, BYTES);
      await store.write(published, BYTES);
      checkEqual(await pruneStoredBackups(store, NOW), [older, expired]);
      checkEqual(await store.read(recent), BYTES);
      checkEqual(await store.read(boundary), BYTES);
      checkEqual(await store.read(newest), BYTES);
      checkEqual(await store.read(cutoff), BYTES);
      checkEqual(await store.read(migration), BYTES);
      checkEqual(await store.read(unknown), BYTES);
      checkEqual(await store.read(published), BYTES);
    },
  },
  {
    name: "invalid retention never deletes copies and zero days still keeps the last 48 hours",
    async run(store) {
      const recent = backupKey(NOW - 48 * HOUR_MS, "sqlite");
      const older = backupKey(NOW - 48 * HOUR_MS - 1000, "sqlite");
      await store.write(recent, BYTES);
      await store.write(older, BYTES);
      await fail(() => pruneStoredBackups(store, NOW, -1));
      await fail(() => pruneStoredBackups(store, NOW, 1.5));
      checkEqual(await store.read(older), BYTES);
      checkEqual(await pruneStoredBackups(store, NOW, 0), [older]);
      checkEqual(await store.read(recent), BYTES);
    },
  },
  {
    name: "fresh starts wait a minute, early alarms do nothing and the next copy is hourly",
    async run(store) {
      const { backups, time, calls, captures } = setup(store);
      await backups.start();
      checkEqual(calls, [NOW + 60_000]);
      await backups.alarm();
      checkEqual(captures.count, 0);
      time.now += 60_000;
      await backups.alarm();
      checkEqual(await store.read(backupKey(time.now, "sqlite")), BYTES);
      checkEqual(captures.count, 1);
      checkEqual(backups.nextWakeUp, time.now + HOUR_MS);
      checkEqual(backups.busy, false);
    },
  },
  {
    name: "restarts arm from the newest matching format and never rotate good backups immediately",
    async run(store) {
      const recent = backupKey(NOW - 10 * 60_000, "sqlite");
      await store.write(recent, BYTES);
      await store.write(backupKey(NOW, "json.gz"), BYTES);
      const { backups, calls, captures } = setup(store);
      await backups.start();
      checkEqual(backups.last, { key: recent, at: NOW - 10 * 60_000 });
      checkEqual(calls, [NOW + 50 * 60_000]);
      await backups.alarm();
      checkEqual(captures.count, 0);
      const stale = setup(store);
      stale.time.now += 2 * DAY_MS;
      await stale.backups.start();
      checkEqual(stale.calls, [stale.time.now + 60_000]);
    },
  },
  {
    name: "overlapping snapshots share capture and repeating a saved second cannot overwrite it",
    async run(store) {
      const base = setup(store);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const backups = createStoredBackups(store, {
        ...base.options,
        async capture() {
          base.captures.count++;
          await held;
          return BYTES;
        },
      });
      const first = backups.snapshot();
      checkEqual(first, backups.snapshot());
      checkEqual(backups.busy, true);
      release();
      checkEqual(await first, backupKey(NOW, "sqlite"));
      await backups.snapshot();
      checkEqual(base.captures.count, 1);
      checkEqual(await keys(store), [backupKey(NOW, "sqlite")]);
    },
  },
  {
    name: "failed captures and writes cannot prune older backups",
    async run(store) {
      const old = backupKey(NOW - 31 * DAY_MS, "sqlite");
      await store.write(old, BYTES);
      const { options } = setup(store);
      await fail(() =>
        createStoredBackups(store, {
          ...options,
          async capture() {
            throw new Error("offline");
          },
        }).snapshot(),
      );
      const failing: Store = {
        ...store,
        async write() {
          throw new Error("offline");
        },
      };
      await fail(() => createStoredBackups(failing, options).snapshot());
      checkEqual(await keys(store), [old]);
      checkEqual(await store.read(old), BYTES);
    },
  },
  {
    name: "a conditional-write loser preserves the concurrent complete copy",
    async run(store) {
      const competing = new Uint8Array([9]);
      const concurrent: Store = {
        ...store,
        async write(key) {
          await store.write(key, competing);
          throw new StoreConflict();
        },
      };
      const { options } = setup(store);
      await createStoredBackups(concurrent, options).snapshot();
      checkEqual(await store.read(backupKey(NOW, "sqlite")), competing);
    },
  },
  {
    name: "failed pruning is retried without capturing or replacing the saved copy",
    async run(store) {
      const old = backupKey(NOW - 31 * DAY_MS, "sqlite");
      await store.write(old, BYTES);
      let offline = true;
      const flaky: Store = {
        ...store,
        async delete(keys) {
          if (offline) {
            offline = false;
            throw new Error("offline");
          }
          await store.delete(keys);
        },
      };
      const { backups, captures } = setup(flaky);
      await fail(() => backups.snapshot());
      checkEqual(captures.count, 1);
      checkEqual(await store.read(old), BYTES);
      await backups.snapshot();
      checkEqual(captures.count, 1);
      checkEqual(await store.read(old), null);
    },
  },
  {
    name: "snapshot recording failures are logged without discarding a saved backup",
    async run(store) {
      const warnings: string[] = [];
      const { options } = setup(store);
      const backups = createStoredBackups(store, {
        ...options,
        async onSnapshot() {
          throw new Error("offline");
        },
        logger: {
          debug() {},
          info() {},
          error() {},
          warn(message) {
            warnings.push(message);
          },
        },
      });
      await backups.snapshot();
      checkEqual(warnings, ["Couldn't record the last backup"]);
      checkEqual(await store.read(backupKey(NOW, "sqlite")), BYTES);
    },
  },
  {
    name: "alarm callers coalesce and remain busy through scheduler acknowledgement",
    async run(store) {
      const { options, time } = setup(store);
      let release!: () => void;
      let enter!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const backups = createStoredBackups(store, {
        ...options,
        scheduler: {
          async schedule() {
            if (time.now === NOW) return;
            enter();
            await held;
          },
          cancel() {},
        },
      });
      await backups.start();
      time.now += 60_000;
      const alarm = backups.alarm();
      checkEqual(alarm, backups.alarm());
      await entered;
      checkEqual(backups.busy, true);
      release();
      await alarm;
      checkEqual(backups.busy, false);
    },
  },
  {
    name: "stopping a running capture prevents it from rearming its timer",
    async run(store) {
      const base = setup(store);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const backups = createStoredBackups(store, {
        ...base.options,
        async capture() {
          await held;
          return BYTES;
        },
      });
      await backups.start();
      base.time.now += 60_000;
      const alarm = backups.alarm();
      await backups.stop();
      release();
      await alarm;
      checkEqual(base.calls, [NOW + 60_000, null]);
      checkEqual(backups.nextWakeUp, null);
    },
  },
  {
    name: "gzip backup names are listed with their UTC times",
    async run(store) {
      const key = backupKey(NOW, "json.gz");
      checkEqual(key, "backups/quaso-20261031T120000Z.json.gz");
      await store.write(key, BYTES);
      checkEqual(await listStoredBackups(store), [{ key, at: NOW }]);
    },
  },
];
