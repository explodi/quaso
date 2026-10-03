// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  backupJsonStream,
  createD1Sql,
  documentSource,
  restoreBackup,
  silentLogger,
  SYSTEM,
} from "@quaso/service";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { startCloudflareService } from "../../server/src/cloudflare_service.ts";
import { unfinishedRestoreAsync } from "../../service/src/backup.ts";
import { heldProvider } from "../../service/src/jobs/testing.ts";
import { handleD1 } from "../src/d1_handler.ts";
import { handleR2 } from "../src/r2_handler.ts";
import { backupKey } from "../../service/src/stored_backups.ts";
import { DAY_MS } from "../../service/src/file_retention.ts";

const bindings = env as unknown as { TEST_D1: D1Database; BACKUPS: R2Bucket };
const NOW = Date.UTC(2026, 9, 3, 12);
const FILE = { path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' };
async function privateFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  expect(request.headers.has("Authorization")).toBe(false);
  const host = new URL(request.url).hostname;
  if (host === "d1.quaso.internal") return handleD1(request, bindings.TEST_D1);
  if (host === "r2.quaso.internal") return handleR2(request, bindings.BACKUPS);
  throw new Error(`Unexpected public request: ${request.url}`);
}
const sql = createD1Sql({ fetch: privateFetch });
const options = {
  secretKey: "s".repeat(32),
  logger: silentLogger,
  fetch: privateFetch,
  clock: () => NOW,
};

describe("the container's async Cloudflare host", () => {
  beforeEach(async () => {
    await resetUploadSql(sql);
    const page = await bindings.BACKUPS.list();
    await bindings.BACKUPS.delete(page.objects.map((object) => object.key));
  });
  it("nightly exports reread saved backup retention without restarting", async () => {
    const host = await startCloudflareService({ ...options, backups: true });
    try {
      const old = backupKey(NOW - 10 * DAY_MS, "json.gz");
      const recent = backupKey(NOW - DAY_MS, "json.gz");
      await bindings.BACKUPS.put(old, "old");
      await bindings.BACKUPS.put(recent, "recent");
      await host.snapshot();
      expect(await bindings.BACKUPS.get(old)).not.toBeNull();
      await host.service.updateSettings(SYSTEM, { backupRetentionDays: 7 });
      await host.snapshot();
      expect(await bindings.BACKUPS.get(old)).toBeNull();
      expect(await bindings.BACKUPS.get(recent)).not.toBeNull();
    } finally {
      host.close();
    }
  });
  it("owns the service and publishes files and nightly backups through private storage", async () => {
    let now = NOW;
    const host = await startCloudflareService({ ...options, backups: true, clock: () => now });
    try {
      expect((await host.service.getHealth(SYSTEM, {})).nextWakeUp).toBe(Date.UTC(2026, 9, 4, 3));
      const token = await host.service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
      expect((await host.service.authenticateToken(SYSTEM, { secret: token.secret }))?.scope).toBe(
        "upload",
      );
      await host.service.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      now += 5000;
      await host.alarm();
      expect(await (await bindings.BACKUPS.get("published/de/menu.json"))?.text()).toBe(
        '{"hello":"Hello"}\n',
      );
      const key = await host.snapshot();
      const object = await bindings.BACKUPS.get(key);
      expect(object).not.toBeNull();
      const saved = (await new Response(
        object!.body.pipeThrough(new DecompressionStream("gzip")),
      ).json()) as { tables: Record<string, unknown[]> };
      expect(saved.tables.strings).toHaveLength(1);
      const [metadata] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'last_backup'" },
      ]);
      expect(JSON.parse(String(metadata[0].value))).toEqual({ at: now, file: key });
    } finally {
      host.close();
    }
  });
  it("restores a portable gzip export into an empty database and resumes the nightly schedule", async () => {
    const source = await startCloudflareService({ ...options, backups: true });
    let document: unknown;
    try {
      await source.service.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      const key = await source.snapshot();
      const object = await bindings.BACKUPS.get(key);
      document = await new Response(
        object!.body.pipeThrough(new DecompressionStream("gzip")),
      ).json();
    } finally {
      source.close();
    }
    await resetUploadSql(sql);
    await bindings.BACKUPS.delete("published/de/menu.json");
    const target = await startCloudflareService({ ...options, backups: true });
    try {
      const result = await restoreBackup(target.service, documentSource(document));
      expect(result.tables.strings).toBe(1);
      expect(await (await bindings.BACKUPS.get("published/de/menu.json"))?.text()).toBe(
        '{"hello":"Hello"}\n',
      );
      expect((await target.service.getHealth(SYSTEM, {})).nextWakeUp).toBe(Date.UTC(2026, 9, 4, 3));
    } finally {
      target.close();
    }
  });
  it("an unfinished restore survives restart without exporting partial data", async () => {
    const source = await startCloudflareService(options);
    let document: { format: "quaso-backup"; version: 1; schemaVersion: number };
    try {
      await source.service.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      document = await new Response(backupJsonStream(source.service, SYSTEM)).json();
    } finally {
      source.close();
    }
    await resetUploadSql(sql);
    const interrupted = await startCloudflareService({ ...options, backups: true });
    try {
      await interrupted.service.beginRestore(SYSTEM, {
        format: document.format,
        version: document.version,
        schemaVersion: document.schemaVersion,
      });
      await expect(interrupted.snapshot()).rejects.toThrow("Finish restoring");
    } finally {
      interrupted.close();
    }
    const resumed = await startCloudflareService({ ...options, backups: true });
    try {
      expect((await resumed.service.getHealth(SYSTEM, {})).nextWakeUp).toBeNull();
      await resumed.alarm();
      await expect(resumed.snapshot()).rejects.toThrow("Finish restoring");
      expect((await bindings.BACKUPS.list({ prefix: "backups/" })).objects).toHaveLength(0);
      await restoreBackup(resumed.service, documentSource(document));
      expect((await resumed.service.getHealth(SYSTEM, {})).nextWakeUp).toBe(
        Date.UTC(2026, 9, 4, 3),
      );
      expect(await resumed.snapshot()).toBe("backups/quaso-20261003T120000Z.json.gz");
    } finally {
      resumed.close();
    }
  });
  it("uses a stable stored key across host restarts", async () => {
    const first = await startCloudflareService({ ...options, secretKey: "ignored" });
    const key = first.secretKey;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    first.close();
    const second = await startCloudflareService({ ...options, secretKey: "different-ignored-key" });
    try {
      expect(second.secretKey).toBe(key);
    } finally {
      second.close();
    }
  });
  it("runs LLM work in the host while publication proceeds during a held provider call", async () => {
    let now = NOW;
    const provider = heldProvider();
    const host = await startCloudflareService({ ...options, provider, clock: () => now });
    try {
      await host.service.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      const work = host.alarm();
      await provider.started;
      expect((await host.service.getHealth(SYSTEM, {})).busy).toBe(true);
      now += 5000;
      await host.alarm();
      expect(await (await bindings.BACKUPS.get("published/de/menu.json"))?.text()).toBe(
        '{"hello":"Hello"}\n',
      );
      provider.release();
      await work;
      expect((await host.service.getHealth(SYSTEM, {})).busy).toBe(false);
      expect(provider.requests).toHaveLength(1);
      const [jobs] = await sql.read([{ sql: "SELECT status FROM jobs" }]);
      expect(jobs).toEqual([{ status: "done" }]);
    } finally {
      provider.release();
      host.close();
    }
  });
  it("drains an in-flight backup before recording the restore's resumable state", async () => {
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const host = await startCloudflareService({
      ...options,
      backups: true,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "PUT" &&
          new URL(request.url).searchParams.get("key")?.startsWith("backups/")
        ) {
          enter();
          await held;
        }
        return privateFetch(input, init);
      },
    });
    try {
      const capture = host.snapshot();
      await entered;
      const restore = host.service.beginRestore(SYSTEM, {
        format: "quaso-backup",
        version: 1,
        schemaVersion: (await host.service.getHealth(SYSTEM, {})).schemaVersion,
      });
      expect(await unfinishedRestoreAsync(sql)).toBeNull();
      release();
      await capture;
      await restore;
      expect((await unfinishedRestoreAsync(sql))?.resumable).toBe(true);
      await expect(host.snapshot()).rejects.toThrow("Finish restoring");
    } finally {
      release();
      host.close();
    }
  });
});
