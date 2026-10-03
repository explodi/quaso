// SPDX-License-Identifier: MIT
/**
 * The `Scheduler` port on Durable Object alarms (design §5.6). A Durable Object has one
 * alarm, and more than one thing wants it: the service's wake-ups (LLM jobs, Sprint 5) and
 * the nightly backup to R2 (Sprint 9). So each purpose keeps its next time in a small
 * record in the object's own key-value storage (`ctx.storage.kv`, outside the service's
 * tables), and the alarm is always set to the earliest one.
 *
 * When the alarm fires, the Durable Object runs the work that is due, then clears each
 * record, unless the work asked for a new time meanwhile (as the service's `alarm()` does
 * with its stored wake-up). If the work throws, the records stay: the runtime runs the
 * alarm again, with backoff, and the service's `start()` arms it again after a restart.
 */
import type { Scheduler } from "@quaso/service";

/** What wants the alarm. */
export const ALARM_PURPOSES = ["service", "backup"] as const;
export type AlarmPurpose = (typeof ALARM_PURPOSES)[number];

/** The prefix of the records in `ctx.storage.kv`. */
export const ALARM_KEY_PREFIX = "quaso:alarm:";

/** What the scheduler needs from `ctx.storage`. */
export type AlarmStorage = Pick<
  DurableObjectStorage,
  "kv" | "getAlarm" | "setAlarm" | "deleteAlarm"
>;

export class AlarmScheduler {
  constructor(private readonly storage: AlarmStorage) {}

  /** The `Scheduler` port for one purpose, such as the service's. */
  for(purpose: AlarmPurpose): Scheduler {
    return {
      schedule: (at) => this.set(purpose, at),
      cancel: () => this.clear(purpose),
    };
  }

  /** Asks for the alarm at `at` for `purpose`, replacing that purpose's earlier time. */
  async set(purpose: AlarmPurpose, at: number): Promise<void> {
    if (!Number.isFinite(at)) throw new RangeError(`Not a time: ${at}`);
    this.storage.kv.put(ALARM_KEY_PREFIX + purpose, Math.floor(at));
    await this.arm();
  }

  /** Forgets `purpose`'s time. */
  async clear(purpose: AlarmPurpose): Promise<void> {
    this.storage.kv.delete(ALARM_KEY_PREFIX + purpose);
    await this.arm();
  }

  /** Every purpose's time, by purpose. */
  pending(): Partial<Record<AlarmPurpose, number>> {
    const out: Partial<Record<AlarmPurpose, number>> = {};
    for (const purpose of ALARM_PURPOSES) {
      const at = this.storage.kv.get<number>(ALARM_KEY_PREFIX + purpose);
      if (typeof at === "number") out[purpose] = at;
    }
    return out;
  }

  /** The purposes whose time has come, earliest first, with the time each asked for. */
  due(now: number): { purpose: AlarmPurpose; at: number }[] {
    return Object.entries(this.pending())
      .filter(([, at]) => at <= now)
      .map(([purpose, at]) => ({ purpose: purpose as AlarmPurpose, at }))
      .sort((a, b) => a.at - b.at);
  }

  /** Clears `purpose`'s record after its work ran, unless it asked for another time meanwhile. */
  done(purpose: AlarmPurpose, at: number): void {
    if (this.storage.kv.get<number>(ALARM_KEY_PREFIX + purpose) === at) {
      this.storage.kv.delete(ALARM_KEY_PREFIX + purpose);
    }
  }

  /** Sets the alarm to the earliest time on record, or deletes it when there is none. */
  async arm(): Promise<void> {
    const times = Object.values(this.pending());
    if (times.length === 0) {
      if ((await this.storage.getAlarm()) !== null) await this.storage.deleteAlarm();
      return;
    }
    const earliest = Math.min(...times);
    if ((await this.storage.getAlarm()) !== earliest) await this.storage.setAlarm(earliest);
  }
}
