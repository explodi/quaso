// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertThrows } from "@std/assert";
import { RATE_RULES, RateLimiter, RateLimitError } from "./rate_limit.ts";

test("setup allows five attempts per address and waits the full fifteen minutes", () => {
  let now = 0;
  const limiter = new RateLimiter(() => now);
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 0);
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 0);
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 0);
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 0);
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 0);
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 900);
  assertEquals(limiter.take("setup:b", RATE_RULES.setup), 0);
  now = 180000;
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 720);
  now = 900000;
  assertEquals(limiter.take("setup:a", RATE_RULES.setup), 0);
});

test("rate limits: a bucket holds its limit and refills over its window", () => {
  let now = 0;
  const limiter = new RateLimiter(() => now);
  const rule = { limit: 3, windowMs: 60_000 };
  assertEquals(
    [1, 2, 3].map(() => limiter.take("a", rule)),
    [0, 0, 0],
  );
  assertEquals(limiter.take("a", rule), 20, "a token comes back every 20 seconds");
  assertEquals(limiter.take("b", rule), 0, "buckets are separate");
  now += 20_000;
  assertEquals(limiter.take("a", rule), 0);
  assertEquals(limiter.take("a", rule), 20);
  now += 3_600_000;
  assertEquals(
    [1, 2, 3, 4].map(() => limiter.take("a", rule)),
    [0, 0, 0, 20],
    "never above the limit",
  );
});

test("rate limits: check refuses with 429 and the seconds to wait", () => {
  const limiter = new RateLimiter(() => 0);
  for (let i = 0; i < RATE_RULES.emailPerIp.limit; i++) {
    limiter.check(["ip", RATE_RULES.emailPerIp], [`address${i}`, RATE_RULES.emailPerAddress]);
  }
  const error = assertThrows(
    () => limiter.check(["ip", RATE_RULES.emailPerIp], ["other", RATE_RULES.emailPerAddress]),
    RateLimitError,
  );
  assertEquals(error.code, "rate_limited");
  assertEquals(error.status, 429);
  assertEquals(error.retryAfter, 1200);
  assertEquals(error.message, "Too many requests. Try again in 20 minutes.");
});

test("rate limits: the rules of design §8", () => {
  assertEquals(RATE_RULES.signInPerIp, { limit: 10, windowMs: 60_000 });
  assertEquals(RATE_RULES.signInPerAccount, { limit: 5, windowMs: 60_000 });
  assertEquals(RATE_RULES.emailPerAddress, { limit: 3, windowMs: 3_600_000 });
  assertEquals(RATE_RULES.writes, { limit: 120, windowMs: 60_000 });
  assertEquals(RATE_RULES.anonymousReads, { limit: 600, windowMs: 60_000 });
});
