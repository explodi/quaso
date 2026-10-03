// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The website's settings, read once from `/config.json`, which the server serves next to
 * the website (design §5.12). Today it only holds the API's address: by default the API is
 * on the same origin, under `/api/v1`, and a deployment that serves the website separately
 * can point it elsewhere.
 */
import { API_BASE } from "@quaso/core";

export interface WebConfig {
  /**
   * The API's base address without a trailing slash: a path such as `/api/v1`, or a full
   * URL such as `https://translate.example.com/api/v1`.
   */
  apiBase: string;
}

export const DEFAULT_CONFIG: WebConfig = { apiBase: API_BASE };

/** Reads `/config.json`'s content, falling back to the defaults for anything missing or odd. */
export function parseConfig(value: unknown): WebConfig {
  if (value === null || typeof value !== "object") return DEFAULT_CONFIG;
  const apiBase = (value as { apiBase?: unknown }).apiBase;
  if (typeof apiBase !== "string") return DEFAULT_CONFIG;
  const trimmed = apiBase.trim().replace(/\/+$/, "");
  if (trimmed === "" || !(trimmed.startsWith("/") || /^https?:\/\//.test(trimmed))) {
    return DEFAULT_CONFIG;
  }
  return { apiBase: trimmed };
}

let loading: Promise<WebConfig> | undefined;

/**
 * Fetches `/config.json` once; later calls get the same answer. A missing or broken file
 * gives the defaults, so the website still works against a server on the same origin.
 */
export function loadConfig(fetcher: Fetch = fetch): Promise<WebConfig> {
  return (loading ??= (async () => {
    try {
      const response = await fetcher("/config.json", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return DEFAULT_CONFIG;
      }
      return parseConfig(await response.json());
    } catch {
      return DEFAULT_CONFIG;
    }
  })());
}

/** Forgets the loaded config, for tests. */
export function resetConfigForTests(): void {
  loading = undefined;
}
