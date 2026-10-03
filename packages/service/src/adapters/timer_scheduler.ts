// SPDX-License-Identifier: MIT
/**
 * The `Scheduler` port on timers (local storage, design §5.6). The service stores the next
 * wake-up in the database itself (`wakeups.ts`), so after a restart `service.start()`
 * re-arms it. A failed wake-up is tried again, as Durable Objects retry their alarms.
 */
import type { Scheduler } from "../ports.ts";

/** The longest delay `setTimeout` accepts, in milliseconds (about 24.8 days). */
const MAX_TIMEOUT = 2 ** 31 - 1;

/** The waits before each retry of a failed alarm: from 2 seconds, doubling, six times. */
export const RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000];

/**
 * Calls `onAlarm` at the scheduled time. Only one wake-up is pending at a time; a new
 * `schedule()` replaces it. Delays longer than `setTimeout` allows are split. `onAlarm`
 * errors are passed to `onError`, and the alarm is tried again after each of
 * `retryDelays`, unless a new wake-up was scheduled meanwhile. `stop()` cancels it for good
 * (graceful shutdown).
 */
export class TimerScheduler implements Scheduler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(
    readonly onAlarm: () => Promise<void>,
    readonly options: {
      now?: () => number;
      onError?: (error: unknown) => void;
      /** The longest single timer, in milliseconds; tests lower it. */
      maxDelay?: number;
      /** The waits before each retry of a failed alarm. Default: `RETRY_DELAYS`. */
      retryDelays?: readonly number[];
    } = {},
  ) {}

  schedule(at: number): void {
    this.cancel();
    if (this.#stopped) return;
    this.#arm(at);
  }

  cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  stop(): void {
    this.#stopped = true;
    this.cancel();
  }

  /** Whether a wake-up is pending. */
  get pending(): boolean {
    return this.#timer !== undefined;
  }

  /** Sets a timer for `at`, or for the longest delay allowed on the way there. */
  #arm(at: number, attempt = 0): void {
    const now = this.options.now ?? Date.now;
    const limit = Math.min(this.options.maxDelay ?? MAX_TIMEOUT, MAX_TIMEOUT);
    const delay = Math.max(0, at - now());
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        if (this.#stopped) return;
        if (delay > limit && now() < at) return this.#arm(at, attempt);
        this.#fire(attempt);
      },
      Math.min(delay, limit),
    );
  }

  /** Runs `onAlarm`, and arms a retry if it fails. */
  #fire(attempt: number): void {
    const onError = this.options.onError ?? ((error) => console.error("Alarm failed:", error));
    let run: Promise<void>;
    try {
      run = this.onAlarm();
    } catch (error) {
      run = Promise.reject(error);
    }
    run.catch((error) => {
      onError(error);
      const wait = (this.options.retryDelays ?? RETRY_DELAYS)[attempt];
      // A wake-up scheduled meanwhile runs the work anyway.
      if (wait === undefined || this.#stopped || this.#timer !== undefined) return;
      const now = this.options.now ?? Date.now;
      this.#arm(now() + wait, attempt + 1);
    });
  }
}
