// SPDX-License-Identifier: MIT
import { type Logger, type ServiceApi, SYSTEM } from "@quaso/service";
import type { Config } from "./config.ts";

export function setupKeyConfigured(config: Pick<Config, "setupKey">): boolean {
  return config.setupKey !== null && config.setupKey.length >= 16;
}

/** Install only an operator-supplied key, before the server starts accepting requests. */
export async function configureSetupKey(service: ServiceApi, config: Config, log: Logger) {
  if (!(await service.getSession(SYSTEM, {})).setupRequired) return;
  if (!setupKeyConfigured(config)) {
    log.warn("Setup is unavailable: set SETUP_KEY to at least 16 random characters, then restart.");
    return;
  }
  await service.ensureSetupToken(SYSTEM, { token: config.setupKey! });
  log.info("Setup required: open /setup and enter the configured setup key.");
}
