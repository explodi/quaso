// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * Cloudflare storage, from the server's side (design §3, §5.11, §5.12): with `SERVICES_URL`
 * set, the service runs in the Durable Object, and the server calls it over the Worker's
 * internal API with `SERVICE_TOKEN`. Nothing is kept here: no data folder, lock file,
 * snapshots or timers (the Durable Object has its own alarm, and runs the LLM jobs). This is
 * how the server runs in a Cloudflare container, and on a VM with Cloudflare storage.
 */
import {
  createHttpServiceClient,
  type Logger,
  type ServiceApi,
  ServiceError,
  ServiceTransportError,
  SYSTEM,
} from "@quaso/service";
import type { Config } from "../config.ts";

/** The internal API can't work with these settings: stop with the message. */
export class RemoteSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteSetupError";
  }
}

export interface RemoteServiceOptions {
  /** Tests pass one that calls an in-process service. */
  fetch?: Fetch;
  /** Passed to the client; tests lower it. */
  retryDelayMs?: number;
  /**
   * Fail when the Worker doesn't answer, instead of going on without it: for one-off
   * commands such as `token create`, which can't wait. Default: false (`serve` starts).
   */
  requireAnswer?: boolean;
}

/**
 * The service over the internal API. Checks it once at start: a refused token, an API
 * that is off, one that doesn't speak this release's version, or a service that reports a
 * problem (such as the Worker's SECRET_KEY) stop the server with a clear message, because
 * they won't fix themselves. When the Worker doesn't answer at all, the server starts
 * anyway (it may be deploying), and `/healthz` says so until it answers; with
 * `requireAnswer`, that fails too.
 */
export async function connectRemoteService(
  config: Pick<Config, "servicesUrl" | "serviceToken">,
  log: Logger,
  options: RemoteServiceOptions = {},
): Promise<ServiceApi> {
  const url = config.servicesUrl;
  const token = config.serviceToken;
  if (!url || !token) throw new RemoteSetupError("SERVICES_URL needs SERVICE_TOKEN.");
  const service = createHttpServiceClient({
    url,
    token,
    fetch: options.fetch,
    logger: log,
    retryDelayMs: options.retryDelayMs,
  });
  try {
    const health = await service.getHealth(SYSTEM, {});
    log.info("Using Cloudflare storage", {
      servicesUrl: url,
      schemaVersion: health.schemaVersion,
      revision: health.revision,
    });
  } catch (error) {
    if (error instanceof ServiceTransportError) {
      const detail = error.detail.replace(/\.$/, "");
      const noAnswer = error.failure === "network" || error.failure === "gateway";
      if (noAnswer && options.requireAnswer) {
        throw new RemoteSetupError(
          `Cloudflare storage at ${url} isn't answering: ${detail}. ` +
            "Check SERVICES_URL, and that the Worker is deployed, then try again.",
        );
      }
      if (noAnswer) {
        log.warn("Cloudflare storage isn't answering yet; starting anyway", {
          servicesUrl: url,
          detail: error.detail,
        });
        return service;
      }
      throw new RemoteSetupError(
        `Cloudflare storage at ${url} refused the server: ${detail}. ` +
          "Check SERVICES_URL and SERVICE_TOKEN, here and on the Worker.",
      );
    }
    if (error instanceof ServiceError) {
      // The Durable Object answered, but the service can't work: the Worker's settings.
      throw new RemoteSetupError(
        `Cloudflare storage at ${url} can't serve: ${error.message} ` +
          "Fix the Worker's settings, then start again.",
      );
    }
    throw error;
  }
  return service;
}
