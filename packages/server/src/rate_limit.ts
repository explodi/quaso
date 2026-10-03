// SPDX-License-Identifier: MIT
/**
 * Rate limits (design §8, S6.1, S6.11): token buckets in memory, per process. Each bucket
 * holds `limit` tokens and refills at `limit` per `windowMs`; a request takes one, or is
 * refused with 429 `rate_limited` and a `Retry-After`. With several server processes each
 * counts on its own, and on Cloudflare its rate limiting rules add a shared limit.
 */
import { ServiceError } from "@quaso/service";

export interface RateRule {
  limit: number;
  windowMs: number;
  fixedWindow?: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The limits (design §8). */
export const RATE_RULES = {
  setup: { limit: 5, windowMs: 15 * MINUTE, fixedWindow: true },
  /** Sign-in, sign-up and setup attempts, per IP address. */
  signInPerIp: { limit: 10, windowMs: MINUTE },
  /** Sign-in and sign-up attempts, per account (email address). */
  signInPerAccount: { limit: 5, windowMs: MINUTE },
  /** Password reset and sign-in link requests, per IP address. */
  emailPerIp: { limit: 3, windowMs: HOUR },
  /** Password reset and sign-in link requests, per email address. */
  emailPerAddress: { limit: 3, windowMs: HOUR },
  /** Writes, per person or API key (or IP address, for anonymous writes). */
  writes: { limit: 120, windowMs: MINUTE },
  /** Community comments and language requests, in addition to the general write limit. */
  communityPerIp: { limit: 30, windowMs: MINUTE },
  communityPerUser: { limit: 10, windowMs: MINUTE },
  /** Anonymous reads, per IP address. */
  anonymousReads: { limit: 600, windowMs: MINUTE },
} as const satisfies Record<string, RateRule>;

/** 429 `rate_limited`, with the seconds to wait for `Retry-After`. */
export class RateLimitError extends ServiceError {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("rate_limited", `Too many requests. Try again in ${describeWait(retryAfter)}.`);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

function describeWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

interface Bucket {
  tokens: number;
  updated: number;
  rule: RateRule;
}

/** The most buckets kept; beyond it, full ones are forgotten first. */
const MAX_BUCKETS = 50_000;

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Takes a token from `key`'s bucket: 0 when allowed, or the seconds until one is back.
   * A refused request takes nothing.
   */
  take(key: string, rule: RateRule): number {
    this.#makeRoom();
    const wait = this.#wait(key, rule);
    if (wait === 0) this.#buckets.get(key)!.tokens -= 1;
    return wait;
  }

  /**
   * Throws `RateLimitError` unless every bucket has a token; then takes one from each. A
   * refused request takes nothing from any of them.
   */
  check(...buckets: [key: string, rule: RateRule][]): void {
    this.#makeRoom();
    let wait = 0;
    for (const [key, rule] of buckets) wait = Math.max(wait, this.#wait(key, rule));
    if (wait > 0) throw new RateLimitError(wait);
    for (const [key] of buckets) this.#buckets.get(key)!.tokens -= 1;
  }

  /** Refills `key`'s bucket, and says how long until it has a token (0: it has one). */
  #wait(key: string, rule: RateRule): number {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: rule.limit, updated: now, rule };
      this.#buckets.set(key, bucket);
    } else if (rule.fixedWindow) {
      if (now >= bucket.updated + rule.windowMs) {
        bucket.tokens = rule.limit;
        bucket.updated = now;
      }
    } else {
      const refill = ((now - bucket.updated) * rule.limit) / rule.windowMs;
      bucket.tokens = Math.min(rule.limit, bucket.tokens + refill);
      bucket.updated = now;
    }
    if (bucket.tokens >= 1) return 0;
    if (rule.fixedWindow)
      return Math.max(1, Math.ceil((bucket.updated + rule.windowMs - now) / 1000));
    const missing = 1 - bucket.tokens;
    return Math.max(1, Math.ceil((missing * rule.windowMs) / rule.limit / 1000));
  }

  /** Forgets buckets when there are too many: full ones first. */
  #makeRoom(): void {
    if (this.#buckets.size >= MAX_BUCKETS) this.#prune(this.#now());
  }

  #prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.rule.fixedWindow) {
        if (now >= bucket.updated + bucket.rule.windowMs) this.#buckets.delete(key);
        continue;
      }
      const refill = ((now - bucket.updated) * bucket.rule.limit) / bucket.rule.windowMs;
      if (bucket.tokens + refill >= bucket.rule.limit) this.#buckets.delete(key);
    }
    // Still full of busy buckets: forget the oldest half.
    if (this.#buckets.size >= MAX_BUCKETS) {
      let drop = Math.floor(this.#buckets.size / 2);
      for (const key of this.#buckets.keys()) {
        if (drop-- <= 0) break;
        this.#buckets.delete(key);
      }
    }
  }
}
