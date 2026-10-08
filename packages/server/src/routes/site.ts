// SPDX-License-Identifier: MIT
/**
 * The routes outside the API: `/healthz` (which also says where the data is), `/config.json`
 * for the website, the CLI config's JSON Schema, `/robots.txt` and the OpenAPI document.
 */
import { API_BASE, configJsonSchema } from "@quaso/core";
import { type Logger, type ServiceApi, SYSTEM } from "@quaso/service";
import type { Handler } from "../http/context.ts";
import { json, text } from "../http/response.ts";
import type { ApiRoute } from "./api.ts";
import { openApiDocument } from "./openapi.ts";

export interface SiteRoutesOptions {
  service: ServiceApi;
  log: Logger;
  version: string;
  publicUrl: string;
  apiRoutes: ApiRoute[];
  /** Where the data is: local storage, or private Cloudflare storage (D1 and R2). */
  storage?: "local" | "cloudflare";
}

/** `[method, path, handler]` for each route. */
export function siteRoutes(options: SiteRoutesOptions): [string, string, Handler][] {
  const { service, log, version, publicUrl } = options;
  const storage = options.storage ?? "local";
  const schemaPath = "/schema/config-v1.json";
  const configSchema = configJsonSchema(`${publicUrl}${schemaPath}`);
  const openApi = openApiDocument(options.apiRoutes, { version, publicUrl });

  const health: Handler = async () => {
    try {
      const { schemaVersion, revision, busy, nextWakeUp } = await service.getHealth(SYSTEM, {});
      return json({ ok: true, version, storage, schemaVersion, revision, busy, nextWakeUp });
    } catch (error) {
      log.warn("Health check failed", { error });
      return json(
        {
          ok: false,
          version,
          storage,
          error: { code: "unavailable", message: "The service isn't available." },
        },
        { status: 503 },
      );
    }
  };

  return [
    ["GET", "/healthz", health],
    ["GET", "/config.json", () => Promise.resolve(json({ apiBase: API_BASE }))],
    ["GET", schemaPath, () => Promise.resolve(json(configSchema))],
    ["GET", "/robots.txt", () => Promise.resolve(text("User-agent: *\nDisallow: /api/\n"))],
    ["GET", `${API_BASE}/openapi.json`, () => Promise.resolve(json(openApi))],
  ];
}
