// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { asyncReadMethods } from "../read_methods.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import type { BackupDocument } from "@quaso/core";
import {
  backupJsonStream,
  sqlAsyncBackupReader,
  restoreBackup,
  documentSource,
} from "../backup.ts";
import { resetUploadSql } from "./upload_cases.ts";

const NAME = "gemini_api_key" as const;
const VALUE = "test-credential-never-export-1234";

async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
  checkEqual(JSON.stringify(failure).includes(VALUE), false);
}

export const SECRET_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "restores retain credential names, report missing values and clear the notice when replaced or removed",
    async run(sql) {
      const writes = asyncWriteMethods({ sql, clock: () => 200 });
      await writes.setSecret(SYSTEM, { name: NAME, value: VALUE });
      await writes.setSecret(SYSTEM, {
        name: "email_api_key",
        value: "email-provider-secret-5678",
      });
      const document = (await new Response(
        backupJsonStream(sqlAsyncBackupReader(sql), SYSTEM),
      ).json()) as BackupDocument;
      checkEqual(Object.hasOwn(document.tables, "secrets"), false);
      checkEqual(JSON.stringify(document).includes(VALUE), false);
      await resetUploadSql(sql);
      const result = await restoreBackup(writes, documentSource(document));
      checkEqual(result.missingSecrets, [NAME, "email_api_key"]);
      const reads = asyncReadMethods({ sql });
      checkEqual((await reads.listSecrets(SYSTEM, {})).missingSecrets, result.missingSecrets);
      await writes.setSecret(SYSTEM, { name: NAME, value: "replacement-secret-9876" });
      checkEqual((await reads.listSecrets(SYSTEM, {})).missingSecrets, ["email_api_key"]);
      await writes.removeSecret(SYSTEM, { name: "email_api_key" });
      checkEqual((await reads.listSecrets(SYSTEM, {})).missingSecrets, []);
      checkEqual(
        await sql.read([{ sql: "SELECT key FROM meta WHERE key LIKE 'configured_secret:%'" }]),
        [[{ key: "configured_secret:gemini_api_key" }]],
      );
    },
  },
  {
    name: "set, replace and remove expose only status and record no credential in activity",
    async run(sql) {
      const writes = asyncWriteMethods({ sql, clock: () => 200 });
      const reads = asyncReadMethods({ sql });
      checkEqual(await writes.setSecret(SYSTEM, { name: NAME, value: VALUE }), {
        name: NAME,
        set: true,
        ending: "1234",
        updatedAt: 200,
      });
      const later = asyncWriteMethods({ sql, clock: () => 300 });
      checkEqual((await later.setSecret(SYSTEM, { name: NAME, value: VALUE })).updatedAt, 200);
      checkEqual((await later.setSecret(SYSTEM, { name: NAME, value: "tiny" })).ending, null);
      checkEqual(await reads.listSecrets(SYSTEM, {}), {
        missingSecrets: [],
        secrets: [
          { name: NAME, set: true, ending: null, updatedAt: 300 },
          { name: "email_api_key", set: false, ending: null, updatedAt: null },
        ],
      });
      await writes.removeSecret(SYSTEM, { name: NAME });
      await writes.removeSecret(SYSTEM, { name: NAME });
      const [activity, revision] = await sql.read([
        { sql: "SELECT detail FROM activity ORDER BY id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        activity.map((row) => JSON.parse(String(row.detail))),
        [
          { name: NAME, action: "set" },
          { name: NAME, action: "replaced" },
          { name: NAME, action: "removed" },
        ],
      );
      checkEqual(revision[0].value, "3");
      checkEqual(JSON.stringify(activity).includes(VALUE), false);
    },
  },
  {
    name: "permissions precede validation and internal credentials cannot be edited",
    async run(sql) {
      const writes = asyncWriteMethods({ sql });
      const reads = asyncReadMethods({ sql });
      await rejected(() => reads.listSecrets(ANONYMOUS, {}), "unauthorized");
      await rejected(() => writes.setSecret(ANONYMOUS, { name: NAME, value: "" }), "unauthorized");
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Manager', 'manager', 100)",
        },
      ]);
      await rejected(
        () => writes.setSecret({ type: "user", userId: 1 }, { name: NAME, value: VALUE }),
        "forbidden",
      );
      await rejected(
        () => writes.setSecret(SYSTEM, { name: NAME, value: " " }),
        "validation_failed",
      );
      await rejected(
        () =>
          writes.setSecret(SYSTEM, { name: "instance_signing_key" as typeof NAME, value: VALUE }),
        "validation_failed",
      );
      checkEqual(await sql.read([{ sql: "SELECT * FROM secrets" }]), [[]]);
    },
  },
  {
    name: "a concurrent demotion prevents the retried secret write",
    async run(sql) {
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Admin', 'administrator', 100)",
        },
      ]);
      let demote = true;
      const changing: Sql = {
        ...sql,
        async commit(revision, statements) {
          if (demote) {
            demote = false;
            await sql.commit(revision, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          }
          return await sql.commit(revision, statements);
        },
      };
      await rejected(
        () =>
          asyncWriteMethods({ sql: changing }).setSecret(
            { type: "user", userId: 1 },
            { name: NAME, value: VALUE },
          ),
        "forbidden",
      );
      checkEqual(
        await sql.read([{ sql: "SELECT * FROM secrets" }, { sql: "SELECT * FROM activity" }]),
        [[], []],
      );
    },
  },
];
