// SPDX-License-Identifier: MIT
/** The `Scheduler` port on the Durable Object's one alarm, shared by purposes. */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AlarmScheduler } from "../src/alarm_scheduler.ts";
import { freshObject } from "./env.ts";

describe("the alarm scheduler", () => {
  it("sets the alarm to the earliest purpose, and clears it with the last", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      const alarms = new AlarmScheduler(state.storage);
      const service = alarms.for("service");
      const t = Date.now() + 60_000;
      await service.schedule(t + 5000);
      expect(await state.storage.getAlarm()).toBe(t + 5000);
      await alarms.set("backup", t);
      expect(await state.storage.getAlarm()).toBe(t);
      // A new time replaces the purpose's earlier one.
      await service.schedule(t - 1000);
      expect(await state.storage.getAlarm()).toBe(t - 1000);
      expect(alarms.pending()).toEqual({ service: t - 1000, backup: t });
      await service.cancel();
      expect(await state.storage.getAlarm()).toBe(t);
      await alarms.clear("backup");
      expect(await state.storage.getAlarm()).toBeNull();
      expect(alarms.pending()).toEqual({});
    });
  });

  it("lists what is due, and clears a record only if it wasn't replaced meanwhile", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      const alarms = new AlarmScheduler(state.storage);
      // In the future, so that the alarm doesn't fire during the test.
      const t = Date.now() + 3_600_000;
      await alarms.set("backup", t + 2000);
      await alarms.set("service", t + 1000);
      expect(alarms.due(t)).toEqual([]);
      expect(alarms.due(t + 1500)).toEqual([{ purpose: "service", at: t + 1000 }]);
      expect(alarms.due(t + 2500)).toEqual([
        { purpose: "service", at: t + 1000 },
        { purpose: "backup", at: t + 2000 },
      ]);
      await alarms.set("service", t + 9000);
      alarms.done("service", t + 1000);
      expect(alarms.pending().service).toBe(t + 9000);
      alarms.done("backup", t + 2000);
      expect(alarms.pending()).toEqual({ service: t + 9000 });
      await alarms.arm();
      expect(await state.storage.getAlarm()).toBe(t + 9000);
    });
  });

  it("keeps its records outside the service's tables", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      await new AlarmScheduler(state.storage).set("service", Date.now() + 3_600_000);
      const tables = state.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
        )
        .toArray();
      expect(tables).toEqual([]);
    });
  });

  it("refuses a time that isn't one", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      await expect(new AlarmScheduler(state.storage).set("service", NaN)).rejects.toThrow(
        RangeError,
      );
    });
  });
});
