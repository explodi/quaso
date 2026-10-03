// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
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
    assertEquals(scheduler.pending, true);
    await wait(60);
    assertEquals(calls.length, 1);
    assertEquals(calls[0] >= at - 2, true);
    assertEquals(scheduler.pending, false);
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
    assertEquals(calls, 1);
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
    assertEquals(calls, 0, "the first wake-up was replaced");
    await wait(40);
    assertEquals(calls, 1);
    scheduler.schedule(Date.now() + 10);
    scheduler.cancel();
    await wait(30);
    assertEquals(calls, 1);
    scheduler.stop();
    scheduler.schedule(Date.now());
    assertEquals(scheduler.pending, false, "stopped for good");
    await wait(10);
    assertEquals(calls, 1);
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
    assertEquals(calls, 0, "the clock hasn't reached the time");
    assertEquals(scheduler.pending, true);
    now = 1000;
    await wait(30);
    assertEquals(calls, 1);
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
    assertEquals(errors.map((error) => (error as Error).message).sort(), ["async", "sync"]);
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
    assertEquals(calls, 3, "two failures, then success");
    assertEquals(errors, ["gemini 503 #1", "gemini 503 #2"]);
    assertEquals(scheduler.pending, false);
    assertEquals(giveUpCalls, 3, "the first run and two retries");
    assertEquals(counting.pending, false);
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
    assertEquals(calls, 1, "no retry: the new wake-up is pending");
    assertEquals(scheduler.pending, true);
  } finally {
    scheduler.stop();
  }
});
