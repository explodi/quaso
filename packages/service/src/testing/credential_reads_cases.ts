// SPDX-License-Identifier: MIT
import { passwordForAsync, validateSetupTokenAsync } from "../accounts.ts";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { backupInfoAsync, restoreTokenValidAsync } from "../backup.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";

const TOKEN = "sécret✓";

async function seed(sql: Sql): Promise<void> {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (1, 'Ada', 'ada@example.com', 'test hash', 100), (2, 'No password', 'other@example.com', NULL, 100)",
    },
    { sql: "INSERT INTO meta (key, value) VALUES ('setup_token', ?)", params: [TOKEN] },
  ]);
}

async function restoreMarker(sql: Sql): Promise<void> {
  const info = await backupInfoAsync(sql, SYSTEM, 100);
  await sql.migrate([
    {
      sql: "INSERT INTO meta (key, value) VALUES ('restore', ?)",
      params: [
        JSON.stringify({ schemaVersion: DATABASE_VERSION, startedAt: 100, state: info.state }),
      ],
    },
  ]);
}

export const CREDENTIAL_READ_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "setup tokens match exactly and disappear after setup or token removal",
    async run(sql) {
      checkEqual(await validateSetupTokenAsync(sql, TOKEN), false);
      await seed(sql);
      checkEqual(await validateSetupTokenAsync(sql, TOKEN), true);
      checkEqual(await validateSetupTokenAsync(sql, "sécret"), false);
      checkEqual(await validateSetupTokenAsync(sql, "wrong"), false);
      await sql.commit(1, [{ sql: "UPDATE users SET role = 'administrator' WHERE id = 1" }]);
      checkEqual(await validateSetupTokenAsync(sql, TOKEN), false);
      await sql.commit(2, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" }]);
      checkEqual(await validateSetupTokenAsync(sql, TOKEN), true);
      await sql.commit(3, [{ sql: "DELETE FROM meta WHERE key = 'setup_token'" }]);
      checkEqual(await validateSetupTokenAsync(sql, TOKEN), false);
    },
  },
  {
    name: "sign-in password lookup normalizes email and excludes deleted and passwordless accounts",
    async run(sql) {
      await seed(sql);
      checkEqual(await passwordForAsync(sql, " ADA@EXAMPLE.COM "), {
        userId: 1,
        hash: "test hash",
      });
      checkEqual(await passwordForAsync(sql, "missing@example.com"), null);
      checkEqual(await passwordForAsync(sql, "other@example.com"), null);
      await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" }]);
      checkEqual(await passwordForAsync(sql, "ada@example.com"), null);
    },
  },
  {
    name: "setup-token decisions retain one snapshot across administrator creation",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(1, [{ sql: "UPDATE users SET role = 'administrator' WHERE id = 1" }]);
          return rows;
        },
      };
      checkEqual([await validateSetupTokenAsync(changing, TOKEN), reads], [true, 1]);
      checkEqual(await validateSetupTokenAsync(sql, TOKEN), false);
    },
  },
  {
    name: "restore tokens require a matching unfinished restore even when administrators exist",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [{ sql: "UPDATE users SET role = 'administrator' WHERE id = 1" }]);
      await restoreMarker(sql);
      checkEqual(await validateSetupTokenAsync(sql, TOKEN), false);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, TOKEN), true);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, "wrong"), false);
      await sql.commit(2, [{ sql: "UPDATE users SET display_name = 'Changed' WHERE id = 1" }]);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, TOKEN), false);
    },
  },
  {
    name: "missing restore state or missing token refuses restore credentials",
    async run(sql) {
      await seed(sql);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, TOKEN), false);
      await sql.migrate([
        { sql: "INSERT INTO meta (key, value) VALUES ('restore', '{\"startedAt\":100}')" },
      ]);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, TOKEN), false);
      await sql.migrate([{ sql: "DELETE FROM meta WHERE key = 'restore'" }]);
      await restoreMarker(sql);
      await sql.migrate([{ sql: "DELETE FROM meta WHERE key = 'setup_token'" }]);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, TOKEN), false);
    },
  },
  {
    name: "only the system can check restore credentials before any database read",
    async run(sql) {
      let reads = 0;
      const counted: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          return sql.read(statements);
        },
      };
      let failure: unknown;
      try {
        await restoreTokenValidAsync(counted, ANONYMOUS, TOKEN);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof ServiceError);
      checkEqual([failure.code, reads], ["forbidden", 0]);
    },
  },
  {
    name: "restore credentials retain the final snapshot across subsequent token deletion",
    async run(sql) {
      await seed(sql);
      await restoreMarker(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 2)
            await sql.commit(1, [{ sql: "DELETE FROM meta WHERE key = 'setup_token'" }]);
          return rows;
        },
      };
      checkEqual([await restoreTokenValidAsync(changing, SYSTEM, TOKEN), reads], [true, 2]);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, TOKEN), false);
    },
  },
  {
    name: "new empty schema tables replan without invalidating resumable restore state",
    async run(sql) {
      await seed(sql);
      await restoreMarker(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.migrate([{ sql: "CREATE TABLE new_credentials (id INTEGER PRIMARY KEY)" }]);
          return rows;
        },
      };
      checkEqual([await restoreTokenValidAsync(changing, SYSTEM, TOKEN), reads], [true, 4]);
    },
  },
];
