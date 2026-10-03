// SPDX-License-Identifier: MIT
/**
 * The container (design §5.12): the same Docker image as everywhere (`deploy/Dockerfile`),
 * controlled by a Durable Object from `@cloudflare/containers`. The server inside keeps
 * nothing: its disk is wiped when the instance stops, so it uses private D1/R2 bindings.
 * It goes to sleep after `CONTAINER_SLEEP_AFTER`
 * without requests (default 10 minutes), and the next request the cache can't answer wakes
 * it, which takes a few seconds.
 *
 * The Worker passes the server the settings it needs as environment variables. The Gemini
 * key is passed to the server, which runs the LLM jobs.
 */
import { Container } from "@cloudflare/containers";
import { sha256Hex } from "@quaso/core";
import { handleD1 } from "./d1_handler.ts";
import { handleR2 } from "./r2_handler.ts";
import { createLogger } from "./log.ts";

export function locationHint(value: string | undefined): DurableObjectLocationHint | undefined {
  const hint = value?.trim().toLowerCase();
  const known = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const;
  return known.find((location) => location === hint);
}

/** The container's one instance. */
export const CONTAINER_NAME = "main";

/** The port the server listens on inside the container. */
export const CONTAINER_PORT = 8000;

/** The default sleep timeout. */
export const DEFAULT_SLEEP_AFTER = "10m";

/**
 * Optional settings passed through to the server as they are, when set on the Worker (as
 * secrets or variables): sign-in, email, the setup key, logs and CORS.
 */
export const PASSED_THROUGH = [
  "SETUP_KEY",
  "EMAIL_PROVIDER",
  "EMAIL_API_KEY",
  "EMAIL_FROM",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "LOG_LEVEL",
  "CORS_ORIGINS",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "LLM_CONCURRENCY",
  "LLM_MONTHLY_TOKEN_BUDGET",
  "BACKUP_RETENTION_DAYS",
] as const;

/**
 * Internal host selection is fixed; the operator cannot redirect storage through a public URL.
 */
export function containerEnv(env: Env): Record<string, string> {
  const publicUrl = env.PUBLIC_URL.trim().replace(/\/+$/, "");
  // Optional settings aren't in the generated `Env` (only required secrets are), so they
  // are read by name.
  const all = env as unknown as Record<string, unknown>;
  const vars: Record<string, string> = {
    PORT: String(CONTAINER_PORT),
    PUBLIC_URL: publicUrl,
    QUASO_CLOUDFLARE: "true",
    SECRET_KEY: env.SECRET_KEY,
    // Requests come through the Worker, which sets X-Forwarded-For and X-Request-Id.
    TRUST_PROXY: "true",
  };
  for (const name of PASSED_THROUGH) {
    const value = all[name];
    if (typeof value === "string" && value.trim() !== "") vars[name] = value;
  }
  return vars;
}

/** The sleep timeout: `CONTAINER_SLEEP_AFTER`, such as "10m", "30s" or "1h". */
export function sleepAfter(env: Pick<Env, "CONTAINER_SLEEP_AFTER">): string {
  const value = env.CONTAINER_SLEEP_AFTER?.trim();
  return value && /^[1-9]\d*[smh]$/.test(value) ? value : DEFAULT_SLEEP_AFTER;
}

export class QuasoContainer extends Container<Env> {
  private requests = new Set<Promise<Response>>();
  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env, {
      defaultPort: CONTAINER_PORT,
      sleepAfter: sleepAfter(env),
      envVars: containerEnv(env),
    });
  }
  private async restorePaused() {
    return (await this.ctx.storage.get<boolean>("restorePaused")) === true;
  }
  override async containerFetch(
    ...args: Parameters<Container<Env>["containerFetch"]>
  ): Promise<Response> {
    const work = (async () => {
      if (await this.restorePaused())
        return new Response("The instance is paused for restoration.", { status: 503 });
      return await super.containerFetch(...args);
    })();
    this.requests.add(work);
    try {
      return await work;
    } finally {
      this.requests.delete(work);
    }
  }
  async pauseForRestore(key: string, force = false) {
    const operation = sha256Hex(key);
    await this.ctx.storage.transaction(async (storage) => {
      const owner = await storage.get<string>("restoreOwner");
      if (owner !== undefined && owner !== operation && !force)
        throw new Error(
          "Another restore owns the maintenance pause. Inspect it before using --takeover or --resume.",
        );
      await storage.put("restoreOwner", operation);
      await storage.put("restorePaused", true);
    });
    this.deleteSchedules("wake");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("The container did not stop within 60 seconds.")),
        60_000,
      );
    });
    try {
      await Promise.race([
        (async () => {
          await this.stop();
          await Promise.allSettled([...this.requests]);
          // A request already starting when pause began must settle before the final stop.
          await this.stop();
          const runtime = this.ctx.container;
          if (!runtime) throw new Error("The controller has no container runtime to stop.");
          if (runtime.running) {
            try {
              await runtime.monitor();
            } catch (error) {
              if (runtime.running) throw error;
            }
          }
          if (runtime?.running) throw new Error("The container is still running.");
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async resumeAfterRestore(key: string, force = false) {
    const operation = sha256Hex(key);
    await this.ctx.storage.transaction(async (storage) => {
      const owner = await storage.get<string>("restoreOwner");
      if (!force && owner !== operation)
        throw new Error("This operation does not own the restoration pause.");
      await storage.delete("restoreOwner");
      await storage.delete("restorePaused");
    });
  }
  private async health() {
    const response = await this.containerFetch("http://container/healthz");
    const health = (await response.json()) as {
      ok?: unknown;
      busy?: unknown;
      nextWakeUp?: unknown;
    };
    const validWake =
      health.nextWakeUp === null ||
      (typeof health.nextWakeUp === "number" &&
        Number.isSafeInteger(health.nextWakeUp) &&
        health.nextWakeUp >= 0);
    if (!response.ok || health.ok !== true || typeof health.busy !== "boolean" || !validWake)
      throw new Error("The server didn't report a valid health state.");
    return { busy: health.busy, nextWakeUp: health.nextWakeUp as number | null };
  }
  private async armWake(at: number | null) {
    this.deleteSchedules("wake");
    if (await this.restorePaused()) return;
    if (at !== null) await this.schedule(new Date(Math.max(at, Date.now() + 1000)), "wake");
  }
  override async onActivityExpired() {
    if (await this.restorePaused()) {
      this.deleteSchedules("wake");
      await this.stop();
      return;
    }
    try {
      const health = await this.health();
      const dueWork = health.nextWakeUp !== null && health.nextWakeUp <= Date.now() + 1000;
      await this.armWake(dueWork ? Date.now() + 60_000 : health.nextWakeUp);
      if (health.busy || dueWork) {
        this.renewActivityTimeout();
        return;
      }
      await this.stop();
    } catch (error) {
      // Unknown busy state must not interrupt a provider request or export.
      createLogger("controller").error("Couldn't check the server before sleep", { error });
      this.renewActivityTimeout();
      await this.armWake(Date.now() + 60_000);
    }
  }
  async wake() {
    if (await this.restorePaused()) {
      this.deleteSchedules("wake");
      return;
    }
    try {
      const health = await this.health();
      const dueWork = health.nextWakeUp !== null && health.nextWakeUp <= Date.now() + 1000;
      await this.armWake(dueWork ? Date.now() + 60_000 : health.nextWakeUp);
    } catch (error) {
      createLogger("controller").error("Scheduled container start failed", { error });
      await this.armWake(Date.now() + 60_000);
    }
  }
}

QuasoContainer.outboundByHost = {
  "d1.quaso.internal": (request, bindings) => handleD1(request, (bindings as Env).DB),
  "r2.quaso.internal": (request, bindings) => handleR2(request, (bindings as Env).BACKUPS),
};
