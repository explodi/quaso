// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/** Email delivery over the providers' HTTP APIs, in either deployment. */
import type { Logger } from "./ports.ts";
import { ServiceError } from "./errors.ts";
export type EmailConfig =
  | {
      provider: "resend" | "postmark";
      apiKey: string;
      from: string;
    }
  | {
      provider: "cloudflare";
      accountId: string;
      apiKey: string;
      from: string;
    };

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** The HTTP API of each provider. */
export const EMAIL_ENDPOINTS = {
  resend: "https://api.resend.com/emails",
  postmark: "https://api.postmarkapp.com/email",
} as const;

/** The sender for the configured provider, or null without one. */
export function createEmailSender(
  email: EmailConfig | null,
  options: { fetch?: Fetch; log: Logger },
): EmailSender | null {
  if (email === null) return null;
  if (email.provider === "cloudflare" && !/^[a-f0-9]{32}$/i.test(email.accountId)) {
    throw new ServiceError("bad_request", "Cloudflare needs a 32-character account ID.");
  }
  const endpoint =
    email.provider === "cloudflare"
      ? `https://api.cloudflare.com/client/v4/accounts/${email.accountId}/email/sending/send`
      : EMAIL_ENDPOINTS[email.provider];
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async send(message) {
      const request: { headers: Record<string, string>; body: unknown } =
        email.provider !== "postmark"
          ? {
              headers: { Authorization: `Bearer ${email.apiKey}` },
              body: {
                from: email.from,
                to: email.provider === "cloudflare" ? message.to : [message.to],
                subject: message.subject,
                text: message.text,
                html: message.html,
              },
            }
          : {
              headers: { "X-Postmark-Server-Token": email.apiKey },
              body: {
                From: email.from,
                To: message.to,
                Subject: message.subject,
                TextBody: message.text,
                HtmlBody: message.html,
                MessageStream: "outbound",
              },
            };
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            ...request.headers,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        options.log.error("The email service can't be reached", {
          provider: email.provider,
        });
        throw unavailable();
      }
      if (!response.ok) {
        await response.body?.cancel();
        options.log.error("The email service refused a message", {
          provider: email.provider,
          status: response.status,
        });
        throw unavailable();
      }
      if (email.provider === "cloudflare") {
        const result = (await response.json().catch(() => null)) as {
          success?: boolean;
          result?: { delivered?: string[]; queued?: string[] };
        } | null;
        const delivered =
          Array.isArray(result?.result?.delivered) && result.result.delivered.includes(message.to);
        const queued =
          Array.isArray(result?.result?.queued) && result.result.queued.includes(message.to);
        if (result?.success !== true || (!delivered && !queued)) {
          options.log.error("The email service did not accept a message", {
            provider: email.provider,
          });
          throw unavailable();
        }
      } else {
        await response.body?.cancel();
      }
      options.log.info("Email sent", { provider: email.provider, subject: message.subject });
    },
  };
}

function unavailable(): ServiceError {
  return new ServiceError("unavailable", "The email couldn't be sent. Try again later.");
}
