// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
import { SYSTEM, ANONYMOUS } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { startTestService } from "./test_helpers.ts";

test("synchronous secret administration is write-only, idempotent and excluded from backup rows", async () => {
  using instance = await startTestService();
  const { service, clock, sql } = instance;
  const value = "provider-credential-never-return-5678";
  const status = await service.setSecret(SYSTEM, { name: "gemini_api_key", value });
  assertEquals(status, { name: "gemini_api_key", set: true, ending: "5678", updatedAt: clock.now });
  clock.advance(100);
  assertEquals(await service.setSecret(SYSTEM, { name: "gemini_api_key", value }), status);
  assertEquals(JSON.stringify(await service.listSecrets(SYSTEM, {})).includes(value), false);
  const backup = await service.backupInfo(SYSTEM, {});
  assertEquals(
    backup.tables.some((table) => table.name === "secrets"),
    false,
  );
  const error = await assertRejects(() => service.listSecrets(ANONYMOUS, {}), ServiceError);
  assertEquals(error.code, "unauthorized");
  await service.removeSecret(SYSTEM, { name: "gemini_api_key" });
  assertEquals(sql.query("SELECT * FROM secrets"), []);
  assertEquals(
    sql.query("SELECT summary FROM activity WHERE type = 'secret'").map((row) => row.summary),
    ["Secret gemini_api_key set", "Secret gemini_api_key removed"],
  );
});
