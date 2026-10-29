// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { TimerScheduler } from "./timer_scheduler.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("TimerScheduler calls onAlarm at the scheduled time", async () => {
  const calls: number[] = [];
  const scheduler = new TimerScheduler(() => {
    calls.push(Date.now());
    return Promise.resolve();
  });
  try {
    const at = Date.now() + 20;
    scheduler.schedule(at);
    expect(scheduler.pending).toBe(true);
    await wait(60);
    expect(calls.length).toBe(1);
    expect(calls[0] >= at - 2).toBe(true);
    expect(scheduler.pending).toBe(false);
  } finally {
    scheduler.stop();
  }
});

test("TimerScheduler fires at once for a time in the past", async () => {
  let calls = 0;
  const scheduler = new TimerScheduler(() => {
    calls++;
    return Promise.resolve();
  });
  try {
    scheduler.schedule(0);
    await wait(10);
    expect(calls).toBe(1);
  } finally {
    scheduler.stop();
  }
});

test("a new schedule replaces the pending one; cancel and stop clear it", async () => {
  let calls = 0;
  const scheduler = new TimerScheduler(() => {
    calls++;
    return Promise.resolve();
  });
  try {
    scheduler.schedule(Date.now() + 10);
    scheduler.schedule(Date.now() + 30);
    await wait(20);
    expect(calls, "the first wake-up was replaced").toBe(0);
    await wait(40);
    expect(calls).toBe(1);
    scheduler.schedule(Date.now() + 10);
    scheduler.cancel();
    await wait(30);
    expect(calls).toBe(1);
    scheduler.stop();
    scheduler.schedule(Date.now());
    expect(scheduler.pending, "stopped for good").toBe(false);
    await wait(10);
    expect(calls).toBe(1);
  } finally {
    scheduler.stop();
  }
});

test("long delays are split into timers the runtime accepts", async () => {
  let now = 0;
  let calls = 0;
  const scheduler = new TimerScheduler(
    () => {
      calls++;
      return Promise.resolve();
    },
    { now: () => now, maxDelay: 10 },
  );
  try {
    scheduler.schedule(1000);
    await wait(30);
    expect(calls, "the clock hasn't reached the time").toBe(0);
    expect(scheduler.pending).toBe(true);
    now = 1000;
    await wait(30);
    expect(calls).toBe(1);
  } finally {
    scheduler.stop();
  }
});

test("onAlarm errors go to onError", async () => {
  const errors: unknown[] = [];
  const failing = new TimerScheduler(() => Promise.reject(new Error("async")), {
    onError: (error) => errors.push(error),
  });
  const throwing = new TimerScheduler(
    () => {
      throw new Error("sync");
    },
    { onError: (error) => errors.push(error) },
  );
  try {
    failing.schedule(0);
    throwing.schedule(0);
    await wait(20);
    expect(errors.map((error) => (error as Error).message).sort()).toStrictEqual(["async", "sync"]);
  } finally {
    failing.stop();
    throwing.stop();
  }
});

test("a failed alarm is tried again after each retry delay, then given up", async () => {
  const errors: string[] = [];
  let calls = 0;
  const scheduler = new TimerScheduler(
    () => {
      calls++;
      return calls < 3 ? Promise.reject(new Error(`gemini 503 #${calls}`)) : Promise.resolve();
    },
    { onError: (error) => errors.push((error as Error).message), retryDelays: [5, 5, 5] },
  );
  const giveUp = new TimerScheduler(() => Promise.reject(new Error("down")), {
    onError: () => {},
    retryDelays: [5, 5],
  });
  let giveUpCalls = 0;
  const counting = new TimerScheduler(
    () => {
      giveUpCalls++;
      return giveUp.onAlarm();
    },
    { onError: () => {}, retryDelays: [5, 5] },
  );
  try {
    scheduler.schedule(0);
    counting.schedule(0);
    await wait(100);
    expect(calls, "two failures, then success").toBe(3);
    expect(errors).toStrictEqual(["gemini 503 #1", "gemini 503 #2"]);
    expect(scheduler.pending).toBe(false);
    expect(giveUpCalls, "the first run and two retries").toBe(3);
    expect(counting.pending).toBe(false);
  } finally {
    scheduler.stop();
    giveUp.stop();
    counting.stop();
  }
});

test("a wake-up scheduled during a failing alarm replaces its retry", async () => {
  let calls = 0;
  const scheduler: TimerScheduler = new TimerScheduler(
    () => {
      calls++;
      if (calls === 1) scheduler.schedule(Date.now() + 1000);
      return Promise.reject(new Error("failed"));
    },
    { onError: () => {}, retryDelays: [5] },
  );
  try {
    scheduler.schedule(0);
    await wait(40);
    expect(calls, "no retry: the new wake-up is pending").toBe(1);
    expect(scheduler.pending).toBe(true);
  } finally {
    scheduler.stop();
  }
});
