// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { SYSTEM } from "./api.ts";
import { monthStart } from "./admin.ts";
import { DATABASE_VERSION } from "./migrations.ts";
import { addUser, START_TIME, startTestService } from "./test_helpers.ts";

test("the admin page: version, setup, database, jobs, LLM, usage and the last backup", async () => {
  using instance = await startTestService({ version: "1.2.3", setup: "local" });
  const admin = addUser(instance.sql, "administrator");
  const info = await instance.service.getAdminInfo(admin, {});
  expect(info.version).toBe("1.2.3");
  expect(info.setup).toBe("local");
  expect(info.startedAt).toStrictEqual(START_TIME);
  expect(info.database.schemaVersion).toStrictEqual(DATABASE_VERSION);
  assert(info.database.sizeBytes !== null && info.database.sizeBytes > 0, "node:sqlite's pages");
  expect(info.database.revision).toBe(0);
  expect(info.recentErrors).toStrictEqual([]);
  expect(info.jobs).toStrictEqual({ queued: 0, running: 0, paused: 0 });
  expect(info.llm).toStrictEqual({
    provider: null,
    model: "gemini-flash-latest",
    lastSuccessAt: null,
    lastError: null,
  });
  expect(info.usageThisMonth).toStrictEqual({
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
  });
  expect(info.lastBackup).toBe(null);
});

test("the admin page counts jobs and this month's requests, and shows the last error", async () => {
  using instance = await startTestService({ setup: "cloudflare", databaseSize: () => 12345 });
  const admin = addUser(instance.sql, "administrator");
  for (const status of ["queued", "queued", "running", "paused", "done", "failed"]) {
    instance.sql.run(
      `INSERT INTO jobs (status, priority, source, scope, actor_type, created_at, updated_at)
       VALUES (?, 2, 'website', '{}', 'system', ?, ?)`,
      status,
      START_TIME,
      START_TIME,
    );
  }
  const request = (at: number, outcome: string, tokens: number, error: string | null = null) =>
    instance.sql.run(
      `INSERT INTO llm_requests (provider, model, input_tokens, output_tokens, thinking_tokens,
         outcome, error, created_at) VALUES ('gemini', 'm', ?, ?, ?, ?, ?, ?)`,
      tokens,
      tokens * 2,
      tokens * 3,
      outcome,
      error,
      at,
    );
  request(monthStart(START_TIME) - 1, "ok", 1000); // last month
  request(START_TIME - 3000, "ok", 10);
  request(START_TIME - 2000, "failed", 1, "429 Too Many Requests");
  request(START_TIME - 1000, "partial", 5);
  await instance.service.recordBackup(SYSTEM, { at: START_TIME, file: "backups/quaso.json.gz" });

  const info = await instance.service.getAdminInfo(admin, {});
  expect(info.setup).toBe("cloudflare");
  expect(info.database.sizeBytes, "the host's size wins").toBe(12345);
  expect(info.jobs).toStrictEqual({ queued: 2, running: 1, paused: 1 });
  expect(info.llm.lastSuccessAt).toStrictEqual(START_TIME - 1000);
  expect(info.llm.lastError).toStrictEqual({
    at: START_TIME - 2000,
    message: "429 Too Many Requests",
  });
  expect(info.usageThisMonth).toStrictEqual({
    requests: 3,
    failures: 1,
    inputTokens: 16,
    outputTokens: 32,
    thinkingTokens: 48,
  });
  expect(info.lastBackup).toStrictEqual({ at: START_TIME, file: "backups/quaso.json.gz" });
});
