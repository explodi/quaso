// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { SYSTEM, silentLogger } from "@quaso/service";
import { openAsyncSqlite } from "../../service/src/adapters/node_async_sqlite.ts";
import { createMemoryStore } from "../../service/src/adapters/memory_store.ts";
import { createAsyncService } from "../../service/src/service_async.ts";
import { runCli, withProject } from "../../cli/src/test_helpers.ts";
import { createApp } from "./app.ts";
import { call, testConfig } from "./testing/helpers.ts";

test("published files: HTTP validators, nested history routes and CLI downloads at both publication times", async () => {
  const opened = openAsyncSqlite(":memory:");
  const store = createMemoryStore();
  let now = Date.UTC(2026, 9, 2);
  const service = createAsyncService({
    sql: opened.sql,
    store,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "test",
    clock: () => now,
  });
  try {
    await service.start();
    const path = "menus/main.json";
    const old = '{"hello":"Hello"}\n';
    const fresh = '{"hello":"Hallo"}\n';
    await service.upload(SYSTEM, {
      files: [{ path, repoPath: path, content: old }],
      languages: ["de"],
    });
    now += 5000;
    await service.alarm();
    const firstAt = new Date(now).toISOString();
    await service.importTranslations(SYSTEM, {
      language: "de",
      files: [{ path, content: fresh }],
      as: "blue",
    });
    now += 5000;
    await service.alarm();
    const secondAt = new Date(now).toISOString();
    const token = await service.createApiToken(SYSTEM, { name: "reader", scope: "read" });
    const app = createApp({
      config: testConfig({ CORS_ORIGINS: "https://game.test" }),
      service,
      log: silentLogger,
    });

    const current = await call(app, `/files/de/${path}`);
    assertEquals(current.status, 200);
    assertEquals(await current.text(), fresh);
    assertEquals(
      current.headers.get("Cache-Control"),
      "public, max-age=30, stale-while-revalidate=300",
    );
    const etag = current.headers.get("ETag")!;
    const unchanged = await call(app, `/files/de/${path}`, {
      headers: { "If-None-Match": `W/${etag}` },
    });
    assertEquals([unchanged.status, await unchanged.text()], [304, ""]);
    const head = await call(app, `/files/de/${path}`, { method: "HEAD" });
    assertEquals([head.status, head.headers.get("ETag"), await head.text()], [200, etag, ""]);
    const privateRead = await call(app, `/files/de/${path}`, { key: token.secret });
    assertEquals(privateRead.headers.get("Cache-Control"), "private, no-store");
    assertEquals((await call(app, "/files/de/missing.json")).status, 404);
    const crossOrigin = await call(app, `/files/de/${path}`, {
      headers: { Origin: "https://game.test" },
    });
    assertEquals(crossOrigin.headers.get("Access-Control-Allow-Origin"), "https://game.test");
    assertEquals((await call(app, `/files/de/${path}`, { method: "POST" })).status, 405);
    assertEquals((await call(app, `/api/v1/files/${path}/versions?language=de`)).status, 401);
    const history = await call(app, `/api/v1/files/${path}/versions?language=de`, {
      key: token.secret,
    });
    assertEquals(history.status, 200);
    const { versions } = await history.json();
    assertEquals(
      versions.map((version: { id: number }) => version.id),
      [2, 1],
    );
    const version = await call(app, `/api/v1/files/${path}/versions/1`, { key: token.secret });
    assertEquals(version.status, 200);
    assertEquals((await version.json()).content, old);

    await withProject(
      {
        "quaso.config.json": {
          sourceLanguage: "en",
          languages: ["de"],
          files: [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
        },
        "src/locales/en/menus/main.json": old,
      },
      async (dir) => {
        const options = {
          cwd: dir,
          env: { QUASO_HOSTNAME: "http://quaso.test", QUASO_API_KEY: token.secret },
          fetch: (input: RequestInfo | URL, init?: RequestInit) => app(new Request(input, init)),
        };
        const first = await runCli(["download", "--at", firstAt], options);
        assertEquals(first.code, 0);
        assertEquals(await fs.readFile(join(dir, "src/locales/de/menus/main.json"), "utf8"), old);
        const second = await runCli(["download", "--at", secondAt], options);
        assertEquals(second.code, 0);
        assertEquals(await fs.readFile(join(dir, "src/locales/de/menus/main.json"), "utf8"), fresh);
        const invalid = await runCli(["download", "--at", "2026-02-30T00:00Z"], options);
        assertEquals(invalid.code, 2);
      },
    );
    const [rows] = await opened.sql.read([
      { sql: "SELECT store_key FROM file_versions WHERE id = 1" },
    ]);
    await store.delete([String(rows[0].store_key)]);
    const expired = await call(app, `/api/v1/files/${path}/versions/1`, { key: token.secret });
    assertEquals(expired.status, 410);
    assertEquals((await expired.json()).error.code, "expired");
    await service.revokeApiToken(SYSTEM, { id: token.id });
    assertEquals((await call(app, `/files/de/${path}`, { key: token.secret })).status, 401);
  } finally {
    opened.close();
  }
});
