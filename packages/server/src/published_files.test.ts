// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
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
    expect(current.status).toBe(200);
    expect(await current.text()).toStrictEqual(fresh);
    expect(current.headers.get("Cache-Control")).toStrictEqual(
      "public, max-age=30, stale-while-revalidate=300",
    );
    const etag = current.headers.get("ETag")!;
    const unchanged = await call(app, `/files/de/${path}`, {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect([unchanged.status, await unchanged.text()]).toStrictEqual([304, ""]);
    const head = await call(app, `/files/de/${path}`, { method: "HEAD" });
    expect([head.status, head.headers.get("ETag"), await head.text()]).toStrictEqual([
      200,
      etag,
      "",
    ]);
    const privateRead = await call(app, `/files/de/${path}`, { key: token.secret });
    expect(privateRead.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await call(app, "/files/de/missing.json")).status).toBe(404);
    const crossOrigin = await call(app, `/files/de/${path}`, {
      headers: { Origin: "https://game.test" },
    });
    expect(crossOrigin.headers.get("Access-Control-Allow-Origin")).toStrictEqual(
      "https://game.test",
    );
    expect((await call(app, `/files/de/${path}`, { method: "POST" })).status).toBe(405);
    expect((await call(app, `/api/v1/files/${path}/versions?language=de`)).status).toStrictEqual(
      401,
    );
    const history = await call(app, `/api/v1/files/${path}/versions?language=de`, {
      key: token.secret,
    });
    expect(history.status).toBe(200);
    const { versions } = await history.json();
    expect(versions.map((version: { id: number }) => version.id)).toStrictEqual([2, 1]);
    const version = await call(app, `/api/v1/files/${path}/versions/1`, { key: token.secret });
    expect(version.status).toBe(200);
    expect((await version.json()).content).toStrictEqual(old);

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
          env: { QUASO_HOSTNAME: "https://quaso.test", QUASO_API_KEY: token.secret },
          fetch: (input: RequestInfo | URL, init?: RequestInit) => app(new Request(input, init)),
        };
        const first = await runCli(["download", "--at", firstAt], options);
        expect(first.code).toBe(0);
        expect(
          await fs.readFile(join(dir, "src/locales/de/menus/main.json"), "utf8"),
        ).toStrictEqual(old);
        const second = await runCli(["download", "--at", secondAt], options);
        expect(second.code).toBe(0);
        expect(
          await fs.readFile(join(dir, "src/locales/de/menus/main.json"), "utf8"),
        ).toStrictEqual(fresh);
        const invalid = await runCli(["download", "--at", "2026-02-30T00:00Z"], options);
        expect(invalid.code).toBe(2);
      },
    );
    const [rows] = await opened.sql.read([
      { sql: "SELECT store_key FROM file_versions WHERE id = 1" },
    ]);
    await store.delete([String(rows[0].store_key)]);
    const expired = await call(app, `/api/v1/files/${path}/versions/1`, { key: token.secret });
    expect(expired.status).toBe(410);
    expect((await expired.json()).error.code).toBe("expired");
    await service.revokeApiToken(SYSTEM, { id: token.id });
    expect((await call(app, `/files/de/${path}`, { key: token.secret })).status).toBe(401);
  } finally {
    opened.close();
  }
});
