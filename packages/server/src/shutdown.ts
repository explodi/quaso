// SPDX-License-Identifier: MIT
import type { HttpServer } from "@quaso/runtime/http";
/**
 * Graceful shutdown (design §5.12): on SIGTERM the server stops taking requests (new ones
 * get 503), lets the ones in flight finish, including bodies still arriving, then closes.
 * After a deadline it stops anyway, so a client that keeps a connection open can't hold
 * the process.
 */
import type { App } from "./app.ts";
import { errorResponse } from "./http/errors.ts";

/** How long a shutdown waits for the requests in flight. Docker waits longer (compose.yaml). */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/** Counts the requests in flight, and refuses new ones once draining. */
export class InFlight {
  #count = 0;
  #draining = false;
  #idle: PromiseWithResolvers<void> | null = null;

  /** Requests whose handler hasn't returned yet. */
  get count(): number {
    return this.#count;
  }

  /** The app, counted. Once draining, new requests get 503 with `Retry-After`. */
  wrap(app: App): App {
    return async (request, info) => {
      if (this.#draining) return unavailable();
      this.#count++;
      try {
        return await app(request, info);
      } finally {
        this.#count--;
        if (this.#count === 0) this.#idle?.resolve();
      }
    };
  }

  /** Stops taking requests. Resolves when none are in flight. */
  drain(): Promise<void> {
    this.#draining = true;
    if (this.#count === 0) return Promise.resolve();
    this.#idle ??= Promise.withResolvers<void>();
    return this.#idle.promise;
  }
}

/**
 * Waits for the requests in flight, then shuts the server down (responses still streaming
 * finish too), within `deadlineMs`. Returns false when the deadline came first: the
 * connections still open close when the process exits.
 */
export async function stopServer(
  server: Pick<HttpServer, "shutdown">,
  inFlight: InFlight,
  deadlineMs = SHUTDOWN_DEADLINE_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>(
    (done) => (timer = setTimeout(() => done(false), deadlineMs)),
  );
  const stop = async () => {
    await inFlight.drain();
    await server.shutdown();
    return true as const;
  };
  try {
    return await Promise.race([stop(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(): Response {
  return errorResponse(503, "unavailable", "The server is restarting. Try again in a moment.", {
    headers: { "Retry-After": "5", "Cache-Control": "no-store" },
  });
}
