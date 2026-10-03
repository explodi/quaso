// SPDX-License-Identifier: MIT
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/worker.ts";
import { env } from "./env.ts";

const key = "a".repeat(64);
async function call(path: string, bindings: Env, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://quaso.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    bindings,
    ctx,
  );
  const body = (await response.json()) as Record<string, unknown>;
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, body };
}
function fixture() {
  const id = env.QUASO_CONTAINER.newUniqueId();
  const container = env.QUASO_CONTAINER.get(id);
  const bindings = {
    ...env,
    QUASO_RESTORE_PAUSED: "true",
    QUASO_RESTORE_KEY: key,
    QUASO_CONTAINER: { idFromName: () => id, get: () => container },
  } as unknown as Env;
  return { container, bindings };
}

it("maintenance bypasses warm API responses and published file reads without waking", async () => {
  const f = fixture();
  const normal = { ...f.bindings, QUASO_RESTORE_PAUSED: "false" } as unknown as Env;
  const path = `/api/v1/project?test=${crypto.randomUUID()}`;
  expect((await call(path, normal)).status).toBe(200);
  expect((await call(path, normal)).headers.get("X-Quaso-Cache")).toBe("hit");
  const served = await f.container.served();
  const paused = await call(path, f.bindings);
  expect(paused.status).toBe(503);
  expect(paused.headers.get("Cache-Control")).toBe("private, no-store");
  expect(paused.headers.get("Retry-After")).toBe("60");
  expect((await call("/files/de/main.json", f.bindings)).status).toBe(503);
  expect(await f.container.served()).toBe(served);
});

it("a new Worker version cannot reuse API responses from the previous database timeline", async () => {
  const f = fixture();
  const first = {
    ...f.bindings,
    QUASO_RESTORE_PAUSED: "false",
    CF_VERSION_METADATA: { id: "before-restore", tag: "", timestamp: "" },
  } as unknown as Env;
  const next = {
    ...first,
    CF_VERSION_METADATA: { id: "after-restore", tag: "", timestamp: "" },
  } as Env;
  const path = `/api/v1/project?test=${crypto.randomUUID()}`;
  const before = await call(path, first);
  expect((await call(path, first)).headers.get("X-Quaso-Cache")).toBe("hit");
  const after = await call(path, next);
  expect(after.headers.get("X-Quaso-Cache")).toBe("miss");
  expect(after.body.n).not.toBe(before.body.n);
  expect((await call(path, next)).body.n).toBe(after.body.n);
});

it("restore control is unavailable outside maintenance and rejects unknown operator keys", async () => {
  const f = fixture();
  const normal = { ...f.bindings, QUASO_RESTORE_PAUSED: "false" } as unknown as Env;
  const init = { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "{}" };
  expect((await call("/api/v1/restore/pause", normal, init)).status).toBe(404);
  expect(
    (
      await call("/api/v1/restore/pause", f.bindings, {
        method: "POST",
        headers: { Authorization: `Bearer ${"b".repeat(64)}` },
      })
    ).status,
  ).toBe(403);
  expect((await call("/api/v1/restore/pause", f.bindings)).status).toBe(403);
  expect(await f.container.restoreControl()).toBeUndefined();
});

it("the temporary key authorizes controller RPC and explicit recovery", async () => {
  const f = fixture();
  const init = { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "{}" };
  expect((await call("/api/v1/restore/pause", f.bindings, init)).body).toEqual({ ok: true });
  expect(await f.container.restoreControl()).toEqual(["pause", key, false]);
  const normal = { ...f.bindings, QUASO_RESTORE_PAUSED: "false" } as unknown as Env;
  expect(
    (
      await call("/api/v1/restore/resume", normal, {
        ...init,
        body: JSON.stringify({ force: true }),
      })
    ).body,
  ).toEqual({ ok: true });
  expect(await f.container.restoreControl()).toEqual(["resume", key, true]);
  const cleaned = { ...normal, QUASO_RESTORE_KEY: undefined } as unknown as Env;
  expect((await call("/api/v1/restore/resume", cleaned, init)).status).toBe(404);
});
