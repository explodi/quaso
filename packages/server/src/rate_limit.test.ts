// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { RATE_RULES, RateLimiter, RateLimitError } from "./rate_limit.ts";

test("setup allows five attempts per address and waits the full fifteen minutes", () => {
  let now = 0;
  const limiter = new RateLimiter(() => now);
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(0);
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(0);
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(0);
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(0);
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(0);
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(900);
  expect(limiter.take("setup:b", RATE_RULES.setup)).toBe(0);
  now = 180000;
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(720);
  now = 900000;
  expect(limiter.take("setup:a", RATE_RULES.setup)).toBe(0);
});

test("rate limits: a bucket holds its limit and refills over its window", () => {
  let now = 0;
  const limiter = new RateLimiter(() => now);
  const rule = { limit: 3, windowMs: 60_000 };
  expect([1, 2, 3].map(() => limiter.take("a", rule))).toStrictEqual([0, 0, 0]);
  expect(limiter.take("a", rule), "a token comes back every 20 seconds").toBe(20);
  expect(limiter.take("b", rule), "buckets are separate").toBe(0);
  now += 20_000;
  expect(limiter.take("a", rule)).toBe(0);
  expect(limiter.take("a", rule)).toBe(20);
  now += 3_600_000;
  expect(
    [1, 2, 3, 4].map(() => limiter.take("a", rule)),
    "never above the limit",
  ).toStrictEqual([0, 0, 0, 20]);
});

test("rate limits: check refuses with 429 and the seconds to wait", async () => {
  const limiter = new RateLimiter(() => 0);
  for (let i = 0; i < RATE_RULES.emailPerIp.limit; i++) {
    limiter.check(["ip", RATE_RULES.emailPerIp], [`address${i}`, RATE_RULES.emailPerAddress]);
  }
  const error = await Promise.try(() =>
    limiter.check(["ip", RATE_RULES.emailPerIp], ["other", RATE_RULES.emailPerAddress]),
  ).catch((error: unknown) => error);
  assert(error instanceof RateLimitError);
  expect(error.code).toBe("rate_limited");
  expect(error.status).toBe(429);
  expect(error.retryAfter).toBe(1200);
  expect(error.message).toBe("Too many requests. Try again in 20 minutes.");
});

test("rate limits: the rules of design §8", () => {
  expect(RATE_RULES.signInPerIp).toStrictEqual({ limit: 10, windowMs: 60_000 });
  expect(RATE_RULES.signInPerAccount).toStrictEqual({ limit: 5, windowMs: 60_000 });
  expect(RATE_RULES.emailPerAddress).toStrictEqual({ limit: 3, windowMs: 3_600_000 });
  expect(RATE_RULES.writes).toStrictEqual({ limit: 120, windowMs: 60_000 });
  expect(RATE_RULES.anonymousReads).toStrictEqual({ limit: 600, windowMs: 60_000 });
});
