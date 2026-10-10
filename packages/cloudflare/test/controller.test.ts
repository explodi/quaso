// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { sha256Hex } from "@quaso/core";
import { Container } from "@cloudflare/containers";
import { QuasoContainer, START_LIMITS, TYPICAL_START_MS } from "../src/container.ts";
import { env, freshObject } from "./env.ts";
const NOW = Date.UTC(2026, 9, 3, 12);
function controller(health: unknown, status = 200) {
  const calls = {
    renewed: 0,
    stopped: 0,
    fetched: 0,
    deleted: [] as string[],
    scheduled: [] as { at: number; name: string }[],
  };
  const instance = Object.assign(Object.create(QuasoContainer.prototype), {
    ctx: { storage: { get: async () => false } },
    async containerFetch() {
      calls.fetched++;
      return Response.json(health, { status });
    },
    deleteSchedules(name: string) {
      calls.deleted.push(name);
    },
    async schedule(at: Date, name: string) {
      calls.scheduled.push({ at: at.getTime(), name });
    },
    renewActivityTimeout() {
      calls.renewed++;
    },
    async stop() {
      calls.stopped++;
    },
  }) as QuasoContainer;
  return { instance, calls };
}
describe("controller sleep and wake-up hooks", () => {
  afterEach(() => vi.restoreAllMocks());
  it("registers only the private D1 and R2 storage handlers", async () => {
    const handlers = QuasoContainer.outboundByHost!;
    expect(Object.keys(handlers).sort()).toEqual(["d1.quaso.internal", "r2.quaso.internal"]);
    const context = { containerId: "test", className: "QuasoContainer" };
    const rows = await handlers["d1.quaso.internal"](
      new Request("http://d1.quaso.internal/batch", {
        method: "POST",
        body: JSON.stringify({ statements: [{ sql: "SELECT 42 AS n", params: [] }] }),
      }),
      env as unknown as Env,
      context,
    );
    expect(await rows.json()).toEqual([[{ n: 42 }]]);
    const key = `controller-test/${crypto.randomUUID()}`;
    try {
      const written = await handlers["r2.quaso.internal"](
        new Request(`http://r2.quaso.internal/object?key=${key}`, {
          method: "PUT",
          body: "private storage",
        }),
        env as unknown as Env,
        context,
      );
      expect(written.status).toBe(200);
      const read = await handlers["r2.quaso.internal"](
        new Request(`http://r2.quaso.internal/object?key=${key}`),
        env as unknown as Env,
        context,
      );
      expect(await read.text()).toBe("private storage");
    } finally {
      await env.BACKUPS.delete(key);
    }
  });
  it("drains an already-starting request before its final restore stop and blocks scheduled starts", async () => {
    await runInDurableObject(freshObject(), async (_object, ctx) => {
      const { instance, calls } = controller({ ok: true, busy: true, nextWakeUp: NOW });
      let finish: (response: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const runtime = { running: true };
      Object.assign(instance, {
        ctx: { storage: ctx.storage, container: runtime },
        requests: new Set([pending]),
      });
      vi.spyOn(instance, "stop")
        .mockImplementationOnce(async () => {
          calls.stopped++;
          expect(await ctx.storage.get("restorePaused")).toBe(true);
          finish(new Response());
        })
        .mockImplementationOnce(async () => {
          calls.stopped++;
          runtime.running = false;
        });
      await instance.pauseForRestore("owner");
      expect(calls.stopped).toBe(2);
      expect(await ctx.storage.get("restoreOwner")).toBe(sha256Hex("owner"));
      await instance.wake();
      await instance.onActivityExpired();
      expect(calls.fetched).toBe(0);
      expect(calls.renewed).toBe(0);
      expect(calls.scheduled).toEqual([]);
      await instance.resumeAfterRestore("owner");
      expect(await ctx.storage.get("restorePaused")).toBeUndefined();
    });
  });
  it("a failed stop keeps its durable pause and rejects another restore's ownership", async () => {
    await runInDurableObject(freshObject(), async (_object, ctx) => {
      const { instance } = controller({});
      const runtime = {
        running: true,
        monitor: async () => {
          throw new Error("Still running");
        },
      };
      Object.assign(instance, {
        ctx: { storage: ctx.storage, container: runtime },
        requests: new Set(),
      });
      await expect(instance.pauseForRestore("owner")).rejects.toThrow("Still running");
      expect(await ctx.storage.get("restorePaused")).toBe(true);
      await expect(instance.pauseForRestore("other")).rejects.toThrow("Another restore");
      await expect(instance.resumeAfterRestore("other")).rejects.toThrow("does not own");
      expect(await ctx.storage.get("restoreOwner")).toBe(sha256Hex("owner"));
      await instance.resumeAfterRestore("recovery", true);
      expect(await ctx.storage.get("restorePaused")).toBeUndefined();
      expect(await ctx.storage.get("restoreOwner")).toBeUndefined();
    });
  });
  it("keeps busy work awake and replaces its scheduled wake-up", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { instance, calls } = controller({ ok: true, busy: true, nextWakeUp: NOW + 5000 });
    await instance.onActivityExpired();
    expect(calls.renewed).toBe(1);
    expect(calls.stopped).toBe(0);
    expect(calls.deleted).toEqual(["wake"]);
    expect(calls.scheduled).toEqual([{ at: NOW + 5000, name: "wake" }]);
  });
  it("saves a near future deadline before stopping an idle container", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { instance, calls } = controller({ ok: true, busy: false, nextWakeUp: NOW + 2000 });
    await instance.onActivityExpired();
    expect(calls.stopped).toBe(1);
    expect(calls.scheduled).toEqual([{ at: NOW + 2000, name: "wake" }]);
  });
  it("clears an obsolete wake-up when no background work remains", async () => {
    const { instance, calls } = controller({ ok: true, busy: false, nextWakeUp: null });
    await instance.onActivityExpired();
    expect(calls.stopped).toBe(1);
    expect(calls.deleted).toEqual(["wake"]);
    expect(calls.scheduled).toEqual([]);
  });
  it("lets immediately due work run without repeatedly stopping and starting", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { instance, calls } = controller({ ok: true, busy: false, nextWakeUp: NOW });
    await instance.onActivityExpired();
    expect(calls.stopped).toBe(0);
    expect(calls.renewed).toBe(1);
    expect(calls.scheduled).toEqual([{ at: NOW + 60_000, name: "wake" }]);
  });
  it("preserves unknown busy work when health fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { instance, calls } = controller({ ok: false }, 503);
    await instance.onActivityExpired();
    expect(calls.stopped).toBe(0);
    expect(calls.renewed).toBe(1);
    expect(calls.scheduled).toEqual([{ at: NOW + 60_000, name: "wake" }]);
  });
  it("starts on a scheduled wake and tracks the server's next deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { instance, calls } = controller({ ok: true, busy: false, nextWakeUp: NOW + 86_400_000 });
    await instance.wake();
    expect(calls.fetched).toBe(1);
    expect(calls.scheduled).toEqual([{ at: NOW + 86_400_000, name: "wake" }]);
  });
  it("retries a failed start without relying on incoming requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { instance, calls } = controller({ ok: true, busy: "unknown", nextWakeUp: null });
    await instance.wake();
    expect(calls.scheduled).toEqual([{ at: NOW + 60_000, name: "wake" }]);
  });
});

/** A stopped controller whose starts wait until the test finishes them. */
function stoppedController(storage: DurableObjectStorage) {
  const starts: { options: unknown; finish: () => void }[] = [];
  const runtime = { running: false };
  const instance = Object.assign(Object.create(QuasoContainer.prototype), {
    ctx: { storage, container: runtime },
    requests: new Set(),
    startup: null,
    async getState() {
      return { status: runtime.running ? "healthy" : "stopped", lastChange: 0 };
    },
    startAndWaitForPorts(options: unknown) {
      return new Promise<void>((resolve) => {
        starts.push({
          options,
          finish: () => {
            runtime.running = true;
            resolve();
          },
        });
      });
    },
  }) as QuasoContainer;
  return { instance, starts };
}

describe("controller start-up", () => {
  afterEach(() => vi.restoreAllMocks());
  it("starts a sleeping server once for every caller, with room for a slow start", async () => {
    await runInDurableObject(freshObject(), async (_object, ctx) => {
      const { instance, starts } = stoppedController(ctx.storage);
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      expect(await instance.startupStatus()).toEqual({
        state: "starting",
        elapsedMs: 0,
        expectedMs: TYPICAL_START_MS,
      });
      vi.spyOn(Date, "now").mockReturnValue(NOW + 20_000);
      expect(await instance.startupStatus()).toEqual({
        state: "starting",
        elapsedMs: 20_000,
        expectedMs: TYPICAL_START_MS,
      });
      expect(starts.length).toBe(1);
      expect(starts[0].options).toEqual({ ports: 8000, cancellationOptions: START_LIMITS });
    });
  });
  it("remembers how long a start took, for the next progress bar", async () => {
    await runInDurableObject(freshObject(), async (_object, ctx) => {
      const { instance, starts } = stoppedController(ctx.storage);
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      await instance.startupStatus();
      vi.spyOn(Date, "now").mockReturnValue(NOW + 42_000);
      starts[0].finish();
      await vi.waitFor(async () => expect(await ctx.storage.get("lastStartMs")).toBe(42_000));
      expect(await instance.startupStatus()).toEqual({ state: "ready" });
    });
  });
  it("makes a request wait for the start in progress, not a start of its own", async () => {
    await runInDurableObject(freshObject(), async (_object, ctx) => {
      const { instance, starts } = stoppedController(ctx.storage);
      await instance.startupStatus();
      const proxied = vi
        .spyOn(Container.prototype, "containerFetch")
        .mockResolvedValue(new Response("from the server"));
      const response = instance.containerFetch(new Request("http://container/api/v1/project"));
      await vi.waitFor(() => expect(starts.length).toBe(1));
      expect(proxied).not.toHaveBeenCalled();
      starts[0].finish();
      expect(await (await response).text()).toBe("from the server");
      expect(starts.length).toBe(1);
    });
  });
  it("says the instance is paused instead of starting it", async () => {
    await runInDurableObject(freshObject(), async (_object, ctx) => {
      const { instance, starts } = stoppedController(ctx.storage);
      await ctx.storage.put("restorePaused", true);
      expect(await instance.startupStatus()).toEqual({ state: "paused" });
      expect(starts.length).toBe(0);
    });
  });
});
