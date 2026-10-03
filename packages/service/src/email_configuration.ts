// SPDX-License-Identifier: MIT
/** Read configuration and credentials together for each delivery; never return the key. */
import { Email, TestEmailRequest, s, type Fetch } from "@quaso/core";
import type { Actor, ServiceApi } from "./api.ts";
import { createEmailSender } from "./email_sender.ts";
import { badRequest, forbidden } from "./errors.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Logger, Sql } from "./ports.ts";
import { settingsFromData } from "./settings.ts";
import { validateActor, validateInput } from "./validation.ts";

const Message = s.object({
  to: Email,
  subject: s.string({ minLength: 1, maxLength: 500 }),
  text: s.string({ maxLength: 100000 }),
  html: s.string({ maxLength: 100000 }),
});

export function emailMethods(
  sql: Pick<Sql, "read">,
  options: { model: string; logger: Logger; fetch?: Fetch },
): Pick<ServiceApi, "testEmail" | "emailStatus" | "sendEmail"> {
  async function configuration(caller: Actor, test = false) {
    const actor = validateActor(caller);
    if (!test && actor.type !== "system") throw forbidden();
    const [settings, keys, ...permissions] = await sql.read([
      { sql: "SELECT data FROM settings WHERE id = 1" },
      { sql: "SELECT value, updated_at FROM secrets WHERE name = 'email_api_key'" },
      ...permissionReadStatements(actor),
    ]);
    if (test) permissionsFromRows(actor, permissions).require("settings");
    const email = settingsFromData((settings[0]?.data as string) ?? null, options.model).email;
    const key = keys[0];
    const keyUpdatedAt = Number(key?.updated_at ?? 0);
    if (email.provider === "none" || email.from === "" || key === undefined)
      return { sender: null, keyUpdatedAt };
    if (email.provider === "cloudflare" && email.accountId === "")
      return { sender: null, keyUpdatedAt };
    const sender = createEmailSender(
      { ...email, provider: email.provider, apiKey: String(key.value) },
      { log: options.logger, fetch: options.fetch },
    );
    return { sender, keyUpdatedAt };
  }
  return {
    async emailStatus(actor, input) {
      const { sender } = await configuration(actor);
      validateInput(s.object({}), input);
      return { available: sender !== null };
    },
    async sendEmail(actor, input) {
      const { sender } = await configuration(actor);
      const message = validateInput(Message, input);
      if (!sender)
        throw badRequest("Configure the email provider, sender and key in Settings first.");
      await sender.send(message);
      return { ok: true };
    },
    async testEmail(actor, input) {
      const { sender, keyUpdatedAt } = await configuration(actor, true);
      const { to } = validateInput(TestEmailRequest, input);
      if (!sender)
        throw badRequest("Configure the email provider, sender and key in Settings first.");
      try {
        await sender.send({
          to,
          subject: "Quaso email test",
          text: "Your Quaso email settings work.\n",
          html: "<p>Your Quaso email settings work.</p>",
        });
      } finally {
        const rows = await sql.read(permissionReadStatements(actor));
        permissionsFromRows(actor, rows).require("settings");
      }
      return { ok: true, keyUpdatedAt };
    },
  };
}
