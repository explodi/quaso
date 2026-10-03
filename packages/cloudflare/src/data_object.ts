// SPDX-License-Identifier: MIT
/**
 * The Durable Object that holds the data (design §3, §5.12): the service, on the object's
 * SQLite storage, woken up by its alarm. One object, named "main", serves the whole
 * instance, created near `LOCATION_HINT`. It runs synchronous code one event at a time, so
 * operations never interleave, as with local storage.
 *
 * Two ways in:
 * - `fetch`: the internal HTTP API (design §5.11), which the Worker forwards from
 *   `/internal/v1/<method>` as it came, for the server in the container or on a VM;
 * - `call`: the same methods over Workers RPC. A `ServiceError` doesn't survive RPC as a
 *   class, so `call` answers `{ ok: true, result }` or `{ ok: false, status, body }`, and
 *   `unwrapCall` turns the latter back into the error.
 *
 * LLM jobs run here too, with `GEMINI_API_KEY` (`llm.ts`), and the nightly backup to
 * R2 (`nightly_backup.ts`) shares the alarm with the service's wake-ups.
 */
import { DurableObject } from "cloudflare:workers";
import type { ApiErrorBody } from "@quaso/core";
import {
  type Actor,
  createService,
  handleServiceRequest,
  type Logger,
  type Service,
  SERVICE_METHODS,
  type ServiceApi,
  ServiceError,
  type ServiceMethod,
} from "@quaso/service";
import { VERSION } from "../../server/src/version.ts";
import { AlarmScheduler } from "./alarm_scheduler.ts";
import { createDurableObjectSql } from "./do_sql.ts";
import { llmOptionsFromEnv } from "./llm.ts";
import { createLogger } from "./log.ts";
import {
  BACKUP_RETRY_MS,
  nextBackupTime,
  retentionDays,
  writeNightlyBackup,
} from "./nightly_backup.ts";

/** The one object's name. */
export const DATA_OBJECT_NAME = "main";

/** Cloudflare's location hints for Durable Objects. */
export const LOCATION_HINTS: readonly DurableObjectLocationHint[] = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
];

/** What `call` answers. */
export type CallResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; status: number; body: ApiErrorBody };

const METHODS: ReadonlySet<string> = new Set(SERVICE_METHODS);

/** `LOCATION_HINT` when it is one Cloudflare knows, or undefined (anywhere). */
export function locationHint(value: string | undefined): DurableObjectLocationHint | undefined {
  const hint = value?.trim().toLowerCase();
  return LOCATION_HINTS.find((known) => known === hint);
}

/** The data object's stub, created near `LOCATION_HINT` the first time. */
export interface LegacyDataEnv extends Env {
  QUASO_DATA: DurableObjectNamespace<QuasoData>;
  SERVICE_TOKEN: string;
  GEMINI_API_KEY: string;
}

export function dataObject(
  env: Pick<LegacyDataEnv, "QUASO_DATA" | "LOCATION_HINT">,
): DurableObjectStub<QuasoData> {
  const namespace = env.QUASO_DATA;
  const hint = locationHint(env.LOCATION_HINT);
  return namespace.get(
    namespace.idFromName(DATA_OBJECT_NAME),
    hint ? { locationHint: hint } : undefined,
  );
}

/** The result of `call`, or its error rebuilt as a `ServiceError`. */
export function unwrapCall<T>(result: CallResult<T>): T {
  if (result.ok) return result.result;
  throw ServiceError.fromBody(result.body);
}

/**
 * A stand-in for the service when the Worker's settings are wrong: every method fails with
 * the problem, as a service error (503 `unavailable`), so that the internal API still
 * checks the token first, and the server shows the problem and stops instead of waiting.
 */
export function unavailableService(problem: string): ServiceApi {
  const fail = () => Promise.reject(new ServiceError("unavailable", problem));
  return Object.fromEntries(
    SERVICE_METHODS.map((method) => [method, fail]),
  ) as unknown as ServiceApi;
}

/** What is wrong with the Worker's settings for the service, or null. */
export function settingsProblem(env: Pick<Env, "SECRET_KEY">): string | null {
  const key = env.SECRET_KEY?.trim() ?? "";
  if (key === "") {
    return "SECRET_KEY isn't set. Set it with: wrangler secret put SECRET_KEY --env <env> (openssl rand -hex 32).";
  }
  if (key.length < 32) {
    return "SECRET_KEY must be at least 32 characters long (openssl rand -hex 32).";
  }
  return null;
}

export class QuasoData extends DurableObject<LegacyDataEnv> {
  readonly #log: Logger;
  readonly #alarms: AlarmScheduler;
  readonly #service: Service | null = null;
  readonly #problem: string | null;

  constructor(ctx: DurableObjectState, env: LegacyDataEnv) {
    super(ctx, env);
    this.#log = createLogger("data");
    this.#alarms = new AlarmScheduler(ctx.storage);
    this.#problem = settingsProblem(env);
    if (this.#problem !== null) {
      this.#log.error("The service can't start", { problem: this.#problem });
      return;
    }
    const service = createService({
      sql: createDurableObjectSql(ctx.storage),
      scheduler: this.#alarms.for("service"),
      secretKey: env.SECRET_KEY.trim(),
      logger: this.#log,
      version: VERSION,
      setup: "cloudflare",
      defaultModel: env.GEMINI_MODEL?.trim() || undefined,
      databaseSize: () => ctx.storage.sql.databaseSize,
      // LLM jobs run here, with GEMINI_API_KEY (design §5.6).
      ...llmOptionsFromEnv(env, this.#log),
    });
    this.#service = service;
    // Nothing else runs until the database is migrated and the wake-up is armed again. If
    // this fails, the object is reset, and the next request tries again.
    void ctx.blockConcurrencyWhile(async () => {
      await service.start();
      await this.#armBackup();
    });
  }

  /**
   * Point-in-time recovery (design §5.12), an operator's action through the Worker's
   * `POST /internal/v1/pitr`: the storage goes back to how it was at `at` (within the last
   * 30 days) when the object starts next. Call `restart()` next.
   */
  async restoreToTime(at: number): Promise<{ bookmark: string }> {
    const bookmark = await this.ctx.storage.getBookmarkForTime(at);
    await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.#log.warn("Restoring to an earlier time at the next start", { at, bookmark });
    return { bookmark };
  }

  /** Resets the object, so that it starts again (after `restoreToTime`, on its data then). */
  restart(): void {
    this.ctx.abort("Restarting to restore an earlier time");
  }

  /** Arms the nightly backup, when there is a bucket and it isn't armed yet. */
  async #armBackup(): Promise<void> {
    if (!this.env.BACKUPS) return;
    if (this.#alarms.pending().backup !== undefined) return;
    await this.#alarms.set("backup", nextBackupTime(Date.now()));
  }

  /** The nightly backup to R2; after a failure, tried again an hour later. */
  async #nightlyBackup(service: Service): Promise<void> {
    if (!this.env.BACKUPS) return;
    const now = Date.now();
    try {
      await writeNightlyBackup(service, this.env.BACKUPS, {
        now,
        retentionDays: retentionDays(this.env.BACKUP_RETENTION_DAYS),
        log: this.#log,
      });
      await this.#alarms.set("backup", nextBackupTime(now));
    } catch (error) {
      this.#log.error("The nightly backup failed; trying again in an hour", { error });
      await this.#alarms.set("backup", now + BACKUP_RETRY_MS);
    }
  }

  /** Calls a service method over Workers RPC. */
  async call(method: string, actor: Actor, input: unknown): Promise<CallResult> {
    try {
      if (!METHODS.has(method)) {
        throw new ServiceError("not_found", `The service has no method ${method}.`);
      }
      const service = this.#ready();
      const fn = service[method as ServiceMethod] as (a: Actor, i: unknown) => Promise<unknown>;
      return { ok: true, result: await fn.call(service, actor, input ?? {}) };
    } catch (error) {
      if (error instanceof ServiceError) {
        return { ok: false, status: error.status, body: error.toBody() };
      }
      this.#log.error("The service failed", { method, error });
      const internal = new ServiceError("internal", "Something went wrong in the service.");
      return { ok: false, status: internal.status, body: internal.toBody() };
    }
  }

  /** The internal HTTP API, as the Worker forwards it. It checks `SERVICE_TOKEN` itself. */
  override async fetch(request: Request): Promise<Response> {
    const service =
      this.#service ?? unavailableService(this.#problem ?? "The service isn't ready.");
    try {
      return await handleServiceRequest(request, service, {
        token: this.env.SERVICE_TOKEN,
        logger: this.#log,
      });
    } catch (error) {
      // The service's own errors are answered above; this is the request failing, such as
      // a body that broke off. A 503 without the service's mark: reads are tried again.
      this.#log.error("The internal API couldn't answer", { error });
      return Response.json(
        {
          error: { code: "unavailable", message: "The request failed. Try again in a moment." },
        },
        { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "5" } },
      );
    }
  }

  /**
   * Runs what is due: the service's wake-up and the nightly backup. If the service's work
   * throws, the runtime runs the alarm again with backoff; the records stay until the work
   * has run. A failed backup asks for another try itself.
   */
  override async alarm(): Promise<void> {
    const service = this.#ready();
    for (const { purpose, at } of this.#alarms.due(Date.now())) {
      if (purpose === "service") await service.alarm();
      if (purpose === "backup") await this.#nightlyBackup(service);
      this.#alarms.done(purpose, at);
    }
    await this.#alarms.arm();
  }

  #ready(): Service {
    if (this.#service === null) {
      throw new ServiceError("unavailable", this.#problem ?? "The service isn't ready.");
    }
    return this.#service;
  }
}
