// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The optional human check on the sign-up and volunteer forms (design §5.8, S6.6):
 * Cloudflare Turnstile, when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set. The
 * website shows the widget and sends its token as `humanCheck`; the server asks Turnstile
 * whether it is good before calling the service.
 */
import { badRequest, type Logger, ServiceError } from "@quaso/service";
import type { Config } from "./config.ts";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Checks a form's `humanCheck` token; does nothing when the check is off. */
export type HumanCheck = (token: string | undefined, ip: string | null) => Promise<void>;

export function createHumanCheck(
  turnstile: Config["turnstile"],
  options: { fetch?: Fetch; log: Logger },
): HumanCheck {
  if (turnstile === null) return () => Promise.resolve();
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return async (token, ip) => {
    if (token === undefined || token.trim() === "") {
      throw badRequest("Complete the human check first.");
    }
    const form = new URLSearchParams({ secret: turnstile.secretKey, response: token });
    if (ip) form.set("remoteip", ip);
    let outcome: { success?: boolean; "error-codes"?: string[] };
    try {
      const response = await doFetch(TURNSTILE_VERIFY_URL, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      outcome = await response.json();
    } catch (error) {
      options.log.error("Turnstile can't be reached", { error });
      throw new ServiceError("unavailable", "The human check isn't available. Try again later.");
    }
    if (outcome.success !== true) {
      options.log.info("Human check failed", { codes: outcome["error-codes"] });
      throw badRequest("The human check failed. Try it again.");
    }
  };
}
