// SPDX-License-Identifier: MIT
/**
 * Whether the server is awake. A deployment whose server sleeps, such as Cloudflare's,
 * serves the website itself and answers `/wake` with how far along a start is, starting the
 * server when asked. Any other answer, such as the website's page from a server that is
 * always on, means awake, so the website waits only where there is something to wait for.
 */
import type { Fetch } from "@quaso/core";
import { useSyncExternalStore } from "react";

export type ServerState =
  | { state: "awake" }
  /** `elapsedMs` was measured when the answer arrived, at `receivedAt`. */
  | { state: "starting"; elapsedMs: number; expectedMs: number; receivedAt: number }
  | { state: "paused" };

export const AWAKE: ServerState = { state: "awake" };

/** How often the website asks again while the server starts. */
export const POLL_MS = 2000;

/** Reads `/wake`'s answer. */
export function parseWake(value: unknown, receivedAt: number): ServerState {
  if (value === null || typeof value !== "object") return AWAKE;
  const answer = value as { state?: unknown; elapsedMs?: unknown; expectedMs?: unknown };
  if (answer.state === "paused") return { state: "paused" };
  const timed = typeof answer.elapsedMs === "number" && typeof answer.expectedMs === "number";
  if (answer.state !== "starting" || !timed) return AWAKE;
  return {
    state: "starting",
    elapsedMs: answer.elapsedMs as number,
    expectedMs: answer.expectedMs as number,
    receivedAt,
  };
}

/** Asks `/wake` once. A failure means awake: the website's own requests then say what's wrong. */
export async function askServer(fetcher: Fetch = fetch, now = Date.now): Promise<ServerState> {
  try {
    const response = await fetcher("/wake", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const json = response.headers.get("Content-Type")?.includes("application/json");
    if (!response.ok || !json) {
      await response.body?.cancel();
      return AWAKE;
    }
    return parseWake(await response.json(), now());
  } catch {
    return AWAKE;
  }
}

let current: ServerState = AWAKE;
const listeners = new Set<() => void>();
let waiting: Promise<void> | null = null;

function publish(state: ServerState) {
  current = state;
  for (const listener of listeners) listener();
}

/**
 * Asks until the server is awake, publishing each answer for `useServerState`. Calls made
 * while it asks share the same wait.
 */
export function waitUntilAwake(
  fetcher: Fetch = fetch,
  sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
): Promise<void> {
  waiting ??= (async () => {
    try {
      for (;;) {
        const state = await askServer(fetcher);
        publish(state);
        if (state.state === "awake") return;
        await sleep(POLL_MS);
      }
    } finally {
      waiting = null;
    }
  })();
  return waiting;
}

/** The server's state, as `waitUntilAwake` last heard it. */
export function useServerState(): ServerState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Forgets the state, for tests. */
export function resetServerStateForTests(): void {
  current = AWAKE;
  waiting = null;
}

/** The state `useServerState` would return, for tests. */
export function serverStateForTests(): ServerState {
  return current;
}
