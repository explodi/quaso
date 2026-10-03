// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { createAsyncService } from "../service_async.ts";
import { check, checkEqual } from "./assert.ts";

const EMAIL = { provider: "resend" as const, from: "Quaso <quaso@example.com>", accountId: "" };
const MESSAGE = { to: "reader@example.com", subject: "Hello", text: "Hello", html: "<p>Hello</p>" };
async function rejected(run: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  check(caught instanceof ServiceError);
  checkEqual(caught.code, code);
  checkEqual(JSON.stringify(caught.toBody()).includes("private-key"), false);
}

export const EMAIL_CONFIGURATION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "saved email settings and rotated keys apply to the next delivery",
    async run(sql) {
      const requests: Request[] = [];
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        clock: () => 200,
        emailFetch: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json({ id: "sent" });
        },
      });
      await service.start();
      checkEqual(await service.emailStatus(SYSTEM, {}), { available: false });
      await rejected(() => service.testEmail(SYSTEM, { to: MESSAGE.to }), "bad_request");
      await service.updateSettings(SYSTEM, { email: EMAIL });
      await service.setSecret(SYSTEM, { name: "email_api_key", value: "private-key-1234" });
      checkEqual(await service.emailStatus(SYSTEM, {}), { available: true });
      const revision = (await service.getProject(SYSTEM, {})).revision;
      checkEqual(await service.testEmail(SYSTEM, { to: MESSAGE.to }), {
        ok: true,
        keyUpdatedAt: 200,
      });
      checkEqual((await service.getProject(SYSTEM, {})).revision, revision);
      checkEqual(requests[0].headers.get("Authorization"), "Bearer private-key-1234");
      checkEqual(((await requests[0].json()) as { to: string[] }).to, [MESSAGE.to]);
      await service.setSecret(SYSTEM, { name: "email_api_key", value: "private-key-5678" });
      await service.updateSettings(SYSTEM, { email: { ...EMAIL, provider: "postmark" } });
      await service.sendEmail(SYSTEM, MESSAGE);
      checkEqual(requests[1].url, "https://api.postmarkapp.com/email");
      checkEqual(requests[1].headers.get("X-Postmark-Server-Token"), "private-key-5678");
      await service.removeSecret(SYSTEM, { name: "email_api_key" });
      checkEqual(await service.emailStatus(SYSTEM, {}), { available: false });
      await rejected(() => service.sendEmail(SYSTEM, MESSAGE), "bad_request");
      checkEqual(requests.length, 2);
    },
  },
  {
    name: "email probes enforce permissions and never disclose provider failures",
    async run(sql) {
      let calls = 0;
      const logs: unknown[] = [];
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        logger: {
          debug: (...args) => logs.push(args),
          info: (...args) => logs.push(args),
          warn: (...args) => logs.push(args),
          error: (...args) => logs.push(args),
        },
        emailFetch: async () => {
          calls++;
          throw new Error("private-key provider diagnostic");
        },
      });
      await service.start();
      await service.updateSettings(SYSTEM, { email: EMAIL });
      await service.setSecret(SYSTEM, { name: "email_api_key", value: "private-key" });
      await rejected(() => service.testEmail(ANONYMOUS, { to: MESSAGE.to }), "unauthorized");
      await rejected(() => service.sendEmail(ANONYMOUS, MESSAGE), "forbidden");
      await rejected(() => service.emailStatus(ANONYMOUS, {}), "forbidden");
      await rejected(() => service.testEmail(SYSTEM, { to: "invalid" }), "validation_failed");
      checkEqual(calls, 0);
      await rejected(() => service.testEmail(SYSTEM, { to: MESSAGE.to }), "unavailable");
      checkEqual(calls, 1);
      checkEqual(JSON.stringify(logs).includes("private-key"), false);
    },
  },
  {
    name: "a demotion during delivery prevents a successful test response",
    async run(sql) {
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        emailFetch: async () => {
          const [rows] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
          await sql.commit(Number(rows[0]?.value ?? 0), [
            { sql: "UPDATE users SET role = 'none' WHERE id = 1" },
          ]);
          return Response.json({ id: "sent" });
        },
      });
      await service.start();
      const [rows] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      await sql.commit(Number(rows[0]?.value ?? 0), [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Owner', 'administrator', 0)",
        },
      ]);
      await service.updateSettings(SYSTEM, { email: EMAIL });
      await service.setSecret(SYSTEM, { name: "email_api_key", value: "private-key" });
      await rejected(
        () => service.testEmail({ type: "user", userId: 1 }, { to: MESSAGE.to }),
        "forbidden",
      );
    },
  },
  {
    name: "Cloudflare requires an account ID and settings reject malformed senders",
    async run(sql) {
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
      });
      await service.start();
      await service.setSecret(SYSTEM, { name: "email_api_key", value: "private-key" });
      await service.updateSettings(SYSTEM, { email: { ...EMAIL, provider: "cloudflare" } });
      checkEqual(await service.emailStatus(SYSTEM, {}), { available: false });
      await rejected(
        () => service.updateSettings(SYSTEM, { email: { ...EMAIL, from: "malformed" } }),
        "validation_failed",
      );
      await rejected(
        () => service.updateSettings(SYSTEM, { email: { ...EMAIL, accountId: "../unsafe" } }),
        "validation_failed",
      );
      await service.updateSettings(SYSTEM, {
        email: { ...EMAIL, provider: "cloudflare", accountId: "a".repeat(32) },
      });
      checkEqual(await service.emailStatus(SYSTEM, {}), { available: true });
    },
  },
];
