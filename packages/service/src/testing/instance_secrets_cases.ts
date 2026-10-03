// SPDX-License-Identifier: MIT
import { SYSTEM } from "../api.ts";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupInfoAsync,
  beginRestoreAsync,
  unfinishedRestoreAsync,
} from "../backup.ts";
import { ensureInstanceSecrets } from "../instance_secrets.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { listSecretsAsync } from "../secrets.ts";
import { check, checkEqual } from "./assert.ts";

export const INSTANCE_SECRETS_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "concurrent first starts agree and do not change project revisions",
    async run(sql) {
      const before = await backupInfoAsync(sql, SYSTEM, 0);
      const [first, second] = await Promise.all([
        ensureInstanceSecrets(sql, 100),
        ensureInstanceSecrets(sql, 200),
      ]);
      checkEqual(first, second);
      check(/^[a-f0-9]{64}$/.test(first.key));
      check(/^[a-f0-9]{64}$/.test(first.salt));
      check(first.key !== first.salt);
      checkEqual(await ensureInstanceSecrets(sql, 300), first);
      checkEqual((await backupInfoAsync(sql, SYSTEM, 0)).revision, before.revision);
      checkEqual(
        (await listSecretsAsync(sql, SYSTEM)).secrets.map((secret) => secret.name),
        ["gemini_api_key", "email_api_key"],
      );
      checkEqual(
        before.tables.some((table) => table.name === "secrets"),
        false,
      );
    },
  },
  {
    name: "restore retains only destination host credentials and remains resumable after restart",
    async run(sql) {
      const secrets = await ensureInstanceSecrets(sql, 100);
      await sql.commit(0, [
        {
          sql: "INSERT INTO secrets (name, value, updated_at) VALUES ('gemini_api_key', 'must-disappear', 100)",
        },
      ]);
      await beginRestoreAsync(
        sql,
        SYSTEM,
        { format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: DATABASE_VERSION },
        200,
      );
      checkEqual(await ensureInstanceSecrets(sql, 300), secrets);
      checkEqual(await unfinishedRestoreAsync(sql), { startedAt: 200, resumable: true });
      const [rows] = await sql.read([{ sql: "SELECT name FROM secrets ORDER BY name" }]);
      checkEqual(rows, [{ name: "instance_key" }, { name: "instance_salt" }]);
    },
  },
  {
    name: "a corrupt stored key fails instead of silently invalidating every cookie",
    async run(sql) {
      await sql.commit(0, [
        {
          sql: "INSERT INTO secrets (name, value, updated_at) VALUES ('instance_key', 'broken', 100)",
        },
      ]);
      let failure: unknown;
      try {
        await ensureInstanceSecrets(sql);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(failure.message, "The stored instance credentials are missing or invalid.");
    },
  },
];
