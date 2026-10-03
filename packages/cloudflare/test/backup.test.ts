// SPDX-License-Identifier: MIT
/**
 * Backups with Cloudflare storage, in workerd: the service's backup and restore methods on
 * Durable Object SQLite, the nightly backup to R2 (Miniflare's) through the alarm, the
 * database size for the admin page, and point-in-time recovery's route in the Worker.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type Actor,
  documentSource,
  restoreBackup,
  type RestoreTarget,
  SYSTEM,
} from "@quaso/service";
import { describe, expect, it } from "vitest";
import { ALARM_KEY_PREFIX, AlarmScheduler } from "../src/alarm_scheduler.ts";
import { unwrapCall } from "../src/data_object.ts";
import {
  BACKUP_RETRY_MS,
  backupKey,
  backupTime,
  nextBackupTime,
  retentionDays,
  upload,
  writeNightlyBackup,
} from "../src/nightly_backup.ts";
import { env } from "./env.ts";
import fixture from "./fixtures/demo.json";
import type { ScenarioInput } from "./scenario.ts";

const input = fixture.input as unknown as ScenarioInput;

function freshData() {
  return env.QUASO_DATA.get(env.QUASO_DATA.newUniqueId());
}

type Data = ReturnType<typeof freshData>;

/** A data object with the demo project in it. */
async function demoData(): Promise<Data> {
  const data = freshData();
  unwrapCall(await data.call("upload", SYSTEM, input.upload));
  for (const request of input.imports) {
    unwrapCall(await data.call("importTranslations", SYSTEM, request));
  }
  return data;
}

/** The service's restore methods on a data object, over RPC. */
function restoreTarget(data: Data): RestoreTarget {
  const method = (name: string) => async (actor: Actor, request: unknown) =>
    unwrapCall(await data.call(name, actor, request));
  return {
    beginRestore: method("beginRestore"),
    restoreRows: method("restoreRows"),
    finishRestore: method("finishRestore"),
  } as RestoreTarget;
}

async function gunzipJson(object: R2ObjectBody): Promise<Record<string, unknown>> {
  const gunzip = new DecompressionStream("gzip");
  const stream = object.body.pipeThrough({
    writable: gunzip.writable as WritableStream<Uint8Array>,
    readable: gunzip.readable,
  });
  return JSON.parse(await new Response(stream).text());
}

describe("backup times and names", () => {
  it("runs at 03:00 UTC, keeps 30 days by default, and names files by their time", () => {
    const noon = Date.UTC(2026, 8, 24, 12);
    expect(nextBackupTime(noon)).toBe(Date.UTC(2026, 8, 25, 3));
    expect(nextBackupTime(Date.UTC(2026, 8, 24, 2, 59))).toBe(Date.UTC(2026, 8, 24, 3));
    expect(nextBackupTime(Date.UTC(2026, 8, 24, 3))).toBe(Date.UTC(2026, 8, 25, 3));
    expect(retentionDays(undefined)).toBe(30);
    expect(retentionDays("7")).toBe(7);
    expect(retentionDays("0")).toBe(30);
    expect(retentionDays("soon")).toBe(30);
    expect(backupKey(Date.UTC(2026, 8, 24, 3, 0, 5))).toBe(
      "backups/quaso-20260924T030005Z.json.gz",
    );
    expect(backupTime("backups/quaso-20260924T030005Z.json.gz")).toBe(
      Date.UTC(2026, 8, 24, 3, 0, 5),
    );
    expect(backupTime("backups/notes.txt")).toBeNull();
  });
});

describe("backups on Durable Object SQLite", () => {
  it("restores the local SQLite fixture, including community tables, with identical exports", async () => {
    const target = freshData();
    const source = fixture.output as unknown as {
      backup: unknown;
      export: { files: unknown[] };
    };
    const result = await restoreBackup(restoreTarget(target), documentSource(source.backup));
    expect(result.tables.glossary_terms).toBe(1);
    expect(result.tables.comments).toBe(1);
    expect(result.tables.language_requests).toBe(1);
    expect(result.tables.language_request_votes).toBe(1);
    const exported = unwrapCall(await target.call("exportFiles", SYSTEM, {})) as {
      files: unknown[];
    };
    expect(exported.files).toEqual(source.export.files);
    const requests = unwrapCall(
      await target.call("listLanguageRequests", { type: "anonymous" }, {}),
    ) as { requests: { tag: string; votes: number }[] };
    expect(requests.requests.map((request) => [request.tag, request.votes])).toEqual([["eo", 1]]);
  });
  it("round-trips the JSON backup into an empty data object", async () => {
    const source = await demoData();
    const info = unwrapCall(await source.call("backupInfo", SYSTEM, {})) as {
      tables: { name: string }[];
    };
    const names = info.tables.map((table) => table.name);
    expect(names).toContain("strings");
    expect(names.some((name) => name.startsWith("_cf_"))).toBe(false);

    await runInDurableObject(source, async (object) => {
      await writeNightlyBackup(
        {
          backupInfo: (a, i) => object.call("backupInfo", a, i).then(unwrapCall),
          backupTables: (a, i) => object.call("backupTables", a, i).then(unwrapCall),
          recordBackup: (a, i) => object.call("recordBackup", a, i).then(unwrapCall),
        } as Parameters<typeof writeNightlyBackup>[0],
        env.BACKUPS,
        { now: Date.UTC(2026, 8, 24, 3), retentionDays: 30, log: console },
      );
    });
    const file = await env.BACKUPS.get("backups/quaso-20260924T030000Z.json.gz");
    expect(file).not.toBeNull();
    const document = await gunzipJson(file!);

    const target = freshData();
    const result = await restoreBackup(restoreTarget(target), documentSource(document));
    expect(result.tables.strings).toBeGreaterThan(0);
    const exported = (data: Data) => data.call("exportFiles", SYSTEM, {}).then(unwrapCall);
    expect(((await exported(target)) as { files: unknown[] }).files).toEqual(
      ((await exported(source)) as { files: unknown[] }).files,
    );
    const again = await target.call("beginRestore", SYSTEM, {
      format: "quaso-backup",
      version: 1,
      schemaVersion: 1,
    });
    expect(again.ok ? 200 : again.status).toBe(409);
  });

  it("starts the nightly backup again when a write lands while it is read", async () => {
    const source = await demoData();
    const said: string[] = [];
    let wrote = false;
    await runInDurableObject(source, async (object) => {
      await writeNightlyBackup(
        {
          backupInfo: (a, i) => object.call("backupInfo", a, i).then(unwrapCall),
          async backupTables(a, i) {
            const chunk = await object.call("backupTables", a, i).then(unwrapCall);
            // A request between two chunks: a new API key.
            if (!wrote && i.table === "translations") {
              wrote = true;
              unwrapCall(
                await object.call("createApiToken", SYSTEM, {
                  name: "Meanwhile",
                  scope: "read",
                }),
              );
            }
            return chunk;
          },
          recordBackup: (a, i) => object.call("recordBackup", a, i).then(unwrapCall),
        } as Parameters<typeof writeNightlyBackup>[0],
        env.BACKUPS,
        {
          now: Date.UTC(2026, 8, 23, 3),
          retentionDays: 30,
          log: { ...console, info: (message: string) => said.push(message) },
        },
      );
    });
    expect(said).toContain("The data changed during the backup; starting it again");
    const key = "backups/quaso-20260923T030000Z.json.gz";
    const document = await gunzipJson((await env.BACKUPS.get(key))!);
    await env.BACKUPS.delete(key);
    const tables = document.tables as Record<string, { name?: string }[]>;
    expect(tables.api_tokens.map((row) => row.name)).toEqual(["Meanwhile"]);
    const result = await restoreBackup(restoreTarget(freshData()), documentSource(document));
    expect(result.tables.api_tokens).toBe(1);
  });

  it("reports the database's size to the admin page", async () => {
    const data = await demoData();
    const [admin] = await runInDurableObject(
      data,
      (_object, state) =>
        state.storage.sql
          .exec(
            "INSERT INTO users (email, display_name, role, created_at) VALUES ('a@b.c', 'A', 'administrator', 1) RETURNING id",
          )
          .toArray() as { id: number }[],
    );
    const info = unwrapCall(
      await data.call("getAdminInfo", { type: "user", userId: admin.id }, {}),
    ) as { database: { sizeBytes: number }; setup: string };
    expect(info.setup).toBe("cloudflare");
    expect(info.database.sizeBytes).toBeGreaterThan(0);
  });
});

describe("the nightly backup", () => {
  it("is armed when the object starts", async () => {
    const data = freshData();
    unwrapCall(await data.call("getHealth", SYSTEM, {}));
    await runInDurableObject(data, (_object, state) => {
      const pending = new AlarmScheduler(state.storage).pending();
      expect(pending.backup).toBe(nextBackupTime(Date.now()));
    });
  });

  it("writes the file to R2 from the alarm, deletes expired ones, and records it", async () => {
    const data = await demoData();
    const old = "backups/quaso-20200101T030000Z.json.gz";
    await env.BACKUPS.put(old, "old");
    await env.BACKUPS.put("backups/notes.txt", "kept");
    // The backup is due; the alarm itself is set for later, so it only runs when asked.
    const due = Date.now() - 1000;
    await runInDurableObject(data, async (_object, state) => {
      state.storage.kv.put(`${ALARM_KEY_PREFIX}backup`, due);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(data)).toBe(true);

    const listed = await env.BACKUPS.list({ prefix: "backups/" });
    const keys = listed.objects.map((object) => object.key);
    expect(keys).not.toContain(old);
    expect(keys).toContain("backups/notes.txt");
    const written = keys.filter((key) => backupTime(key) !== null);
    expect(written.length).toBeGreaterThan(0);
    const newest = written.sort().at(-1)!;
    const document = await gunzipJson((await env.BACKUPS.get(newest))!);
    expect(document.format).toBe("quaso-backup");
    expect((document.tables as Record<string, unknown[]>).strings.length).toBeGreaterThan(0);

    await runInDurableObject(data, (_object, state) => {
      const pending = new AlarmScheduler(state.storage).pending();
      expect(pending.backup).toBe(nextBackupTime(Date.now()));
      const [row] = state.storage.sql
        .exec("SELECT value FROM meta WHERE key = 'last_backup'")
        .toArray() as { value: string }[];
      expect(JSON.parse(row.value).file).toBe(newest);
    });
  });

  it("goes up in equal parts when it is large", async () => {
    // Random bytes don't compress: 11 MiB in parts of 5 MiB is 5 + 5 + 1.
    const size = 11 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536) {
      crypto.getRandomValues(bytes.subarray(i, i + 65536));
    }
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < size; i += 300_000) {
          controller.enqueue(bytes.slice(i, i + 300_000));
        }
        controller.close();
      },
    });
    const key = "backups/quaso-20260920T030000Z.json.gz";
    expect(await upload(env.BACKUPS, key, chunks, 5 * 1024 * 1024)).toBe(size);
    const stored = await env.BACKUPS.get(key);
    expect(stored?.size).toBe(size);
    const digest = async (data: BufferSource) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].join(",");
    expect(await digest(await stored!.arrayBuffer())).toBe(await digest(bytes));
    const small = new Blob(["{}"]).stream() as ReadableStream<Uint8Array>;
    expect(await upload(env.BACKUPS, "backups/small", small, 5 * 1024 * 1024)).toBe(2);
    expect(await (await env.BACKUPS.get("backups/small"))!.text()).toBe("{}");
  });

  it("is tried again an hour later when it fails", () => {
    expect(BACKUP_RETRY_MS).toBe(3_600_000);
  });
});
