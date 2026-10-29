// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { SYSTEM, ANONYMOUS } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { startTestService } from "./test_helpers.ts";

test("synchronous secret administration is write-only, idempotent and excluded from backup rows", async () => {
  using instance = await startTestService();
  const { service, clock, sql } = instance;
  const value = "provider-credential-never-return-5678";
  const status = await service.setSecret(SYSTEM, { name: "gemini_api_key", value });
  expect(status).toStrictEqual({
    name: "gemini_api_key",
    set: true,
    ending: "5678",
    updatedAt: clock.now,
  });
  clock.advance(100);
  expect(await service.setSecret(SYSTEM, { name: "gemini_api_key", value })).toStrictEqual(status);
  expect(JSON.stringify(await service.listSecrets(SYSTEM, {})).includes(value)).toStrictEqual(
    false,
  );
  const backup = await service.backupInfo(SYSTEM, {});
  expect(backup.tables.some((table) => table.name === "secrets")).toBe(false);
  const error = await service.listSecrets(ANONYMOUS, {}).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("unauthorized");
  await service.removeSecret(SYSTEM, { name: "gemini_api_key" });
  expect(sql.query("SELECT * FROM secrets")).toStrictEqual([]);
  expect(
    sql.query("SELECT summary FROM activity WHERE type = 'secret'").map((row) => row.summary),
  ).toStrictEqual(["Secret gemini_api_key set", "Secret gemini_api_key removed"]);
});
