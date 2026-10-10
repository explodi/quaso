// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { ASYNC_READ_METHODS, asyncReadMethods } from "../read_methods.ts";
import { READ_METHODS } from "../api.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const KEY: Actor = { type: "token", tokenId: 7 };

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [{ sql: "UPDATE users SET role = 'administrator' WHERE id = 1" }]);
}

async function rejected(run: () => Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

export const READ_METHOD_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "every read-only service method has an async entry point",
    async run(sql) {
      const repeatableWrites = new Set(["authenticateToken", "resolveSession"]);
      checkEqual(
        [...ASYNC_READ_METHODS].sort(),
        READ_METHODS.filter((method) => !repeatableWrites.has(method)).sort(),
      );
      checkEqual(Object.keys(asyncReadMethods({ sql })).sort(), [...ASYNC_READ_METHODS].sort());
    },
  },
  {
    name: "all validated async entry points read the populated project",
    async run(sql) {
      await seed(sql);
      const readOnly: Sql = {
        ...sql,
        async commit() {
          throw new Error("Read methods cannot commit");
        },
        async migrate() {
          throw new Error("Read methods cannot migrate");
        },
      };
      const api = asyncReadMethods({
        sql: readOnly,
        clock: () => 100,
        defaultModel: "test",
        databaseSize: () => 123,
      });
      checkEqual((await api.getProject(ANONYMOUS, {})).revision, 3);
      checkEqual((await api.listFiles(ANONYMOUS, { language: "de" })).files.length, 2);
      const sources = await api.listFiles(ANONYMOUS, {});
      checkEqual(
        [sources.language, sources.files.length, sources.files[0].repoPath],
        [undefined, 2, "Menus/main.json"],
      );
      checkEqual((await api.listStrings(ANONYMOUS, { language: "de" })).total, 4);
      checkEqual((await api.getString(ANONYMOUS, { id: 1, language: "de" })).source, "Hello");
      await api.getHistory(ANONYMOUS, { id: 1 });
      await api.getActivity(ANONYMOUS, {});
      checkEqual((await api.getStatus(ADMIN, {})).revision, 3);
      checkEqual((await api.exportFiles(ADMIN, {})).revision, 3);
      checkEqual((await api.listApiTokens(ADMIN, {})).tokens.length, 1);
      checkEqual(await api.getHealth(ANONYMOUS, {}), {
        ok: true,
        schemaVersion: DATABASE_VERSION,
        revision: 3,
        busy: false,
        nextWakeUp: null,
      });
      checkEqual((await api.getSettings(ADMIN, {})).models, []);
      const backup = await api.backupInfo(ADMIN, {});
      checkEqual(
        (await api.backupTables(ADMIN, { table: "users", state: backup.state })).rows.length,
        2,
      );
      checkEqual(await api.checkRestoreToken(SYSTEM, { token: "unknown" }), { ok: false });
      checkEqual((await api.getAdminInfo(ADMIN, {})).database.revision, 3);
      checkEqual((await api.getSession(ADMIN, {})).user?.id, 1);
      checkEqual(await api.validateSetupToken(ANONYMOUS, { token: "unknown" }), { ok: false });
      checkEqual((await api.getAccount(ADMIN, {})).id, 1);
      checkEqual((await api.listVolunteerRequests(ADMIN, {})).members, []);
      checkEqual((await api.listMembers(ADMIN, {})).members.length, 1);
      checkEqual((await api.listInvites(ADMIN, {})).invites, []);
      checkEqual((await api.checkInvite(ANONYMOUS, { token: "unknown" })).valid, false);
      checkEqual((await api.listSuggestions(ADMIN, {})).total, 1);
      await rejected(() => api.getJob(ADMIN, { id: 999 }), "not_found");
      checkEqual((await api.listJobs(ADMIN, {})).jobs, []);
      checkEqual((await api.getUsage(ADMIN, { period: "day" })).budget.usedThisMonth, 0);
      checkEqual((await api.listModels(ADMIN, {})).models, []);
      checkEqual((await api.listGlossary(ANONYMOUS, {})).terms, []);
      await api.listComments(ANONYMOUS, { stringId: 1 });
      checkEqual((await api.listLanguageRequests(ANONYMOUS, {})).requests, []);
    },
  },
  {
    name: "actors and inputs are validated while permissions retain error precedence",
    async run(sql) {
      await seed(sql);
      const api = asyncReadMethods({ sql });
      await rejected(() => api.getProject({ type: "user", userId: 0 }, {}), "validation_failed");
      await rejected(
        () => api.getString(ANONYMOUS, { id: 0, language: "de" }),
        "validation_failed",
      );
      await rejected(() => api.getSettings(ANONYMOUS, { unknown: true } as never), "unauthorized");
      await rejected(() => api.getSettings(ADMIN, { unknown: true } as never), "validation_failed");
      await rejected(() => api.listSuggestions(ANONYMOUS, {}), "unauthorized");
      await rejected(() => api.getStatus(ANONYMOUS, {}), "unauthorized");
      await rejected(() => api.checkRestoreToken(ADMIN, { token: "unknown" }), "forbidden");
    },
  },
  {
    name: "revoked keys cannot browse otherwise public data",
    async run(sql) {
      await seed(sql);
      const api = asyncReadMethods({ sql });
      checkEqual((await api.getProject(KEY, {})).revision, 3);
      await sql.commit(3, [{ sql: "UPDATE api_tokens SET revoked_at = 200 WHERE id = 7" }]);
      await rejected(() => api.getProject(KEY, {}), "forbidden");
      await rejected(() => api.listStrings(KEY, { language: "de" }), "forbidden");
      await rejected(() => api.getHistory(KEY, { id: 1 }), "forbidden");
    },
  },
  {
    name: "permission rows are appended to the same data snapshot without an extra read",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(3, [{ sql: "UPDATE api_tokens SET revoked_at = 200 WHERE id = 7" }]);
          return rows;
        },
      };
      const api = asyncReadMethods({ sql: changing });
      checkEqual([(await api.getProject(KEY, {})).revision, reads], [3, 1]);
      await rejected(() => asyncReadMethods({ sql }).getProject(KEY, {}), "forbidden");
    },
  },
  {
    name: "settings recheck permissions after waiting for model metadata",
    async run(sql) {
      await seed(sql);
      let models = 0;
      const api = asyncReadMethods({
        sql,
        models: async () => {
          models++;
          await sql.commit(3, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          return ["model-a"];
        },
      });
      await rejected(() => api.getSettings(ADMIN, {}), "forbidden");
      checkEqual(models, 1);
    },
  },
  {
    name: "unauthorized model and settings requests never reach the provider",
    async run(sql) {
      let models = 0;
      const api = asyncReadMethods({
        sql,
        models: async () => {
          models++;
          return ["model-a"];
        },
      });
      await rejected(() => api.getSettings(ANONYMOUS, {}), "unauthorized");
      await rejected(() => api.listModels(ANONYMOUS, {}), "unauthorized");
      checkEqual(models, 0);
    },
  },
];
