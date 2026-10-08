// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals } from "@std/assert";
import { SYSTEM } from "./api.ts";
import { monthStart } from "./admin.ts";
import { DATABASE_VERSION } from "./migrations.ts";
import { addUser, START_TIME, startTestService } from "./test_helpers.ts";

test("the admin page: version, setup, database, jobs, LLM, usage and the last backup", async () => {
  using instance = await startTestService({ version: "1.2.3", setup: "local" });
  const admin = addUser(instance.sql, "administrator");
  const info = await instance.service.getAdminInfo(admin, {});
  assertEquals(info.version, "1.2.3");
  assertEquals(info.setup, "local");
  assertEquals(info.startedAt, START_TIME);
  assertEquals(info.database.schemaVersion, DATABASE_VERSION);
  assert(info.database.sizeBytes !== null && info.database.sizeBytes > 0, "node:sqlite's pages");
  assertEquals(info.database.revision, 0);
  assertEquals(info.recentErrors, []);
  assertEquals(info.jobs, { queued: 0, running: 0, paused: 0 });
  assertEquals(info.llm, {
    provider: null,
    model: "gemini-flash-latest",
    lastSuccessAt: null,
    lastError: null,
  });
  assertEquals(info.usageThisMonth, {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
  });
  assertEquals(info.lastBackup, null);
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
  assertEquals(info.setup, "cloudflare");
  assertEquals(info.database.sizeBytes, 12345, "the host's size wins");
  assertEquals(info.jobs, { queued: 2, running: 1, paused: 1 });
  assertEquals(info.llm.lastSuccessAt, START_TIME - 1000);
  assertEquals(info.llm.lastError, { at: START_TIME - 2000, message: "429 Too Many Requests" });
  assertEquals(info.usageThisMonth, {
    requests: 3,
    failures: 1,
    inputTokens: 16,
    outputTokens: 32,
    thinkingTokens: 48,
  });
  assertEquals(info.lastBackup, { at: START_TIME, file: "backups/quaso.json.gz" });
});
