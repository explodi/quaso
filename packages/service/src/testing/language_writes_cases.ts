// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { defaultSettings } from "../settings.ts";
import type { Sql } from "../ports.ts";
import {
  addProjectLanguageAsync,
  updateProjectLanguageAsync,
  removeProjectLanguageAsync,
} from "../settings_writes.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };
const OPTIONS = { model: "test", now: 200 };

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager' WHERE id = 2" },
    {
      sql: 'UPDATE strings SET kind = \'plural\', source = \'{"one":"Play","other":"Plays"}\' WHERE id = 2',
    },
    {
      sql: "UPDATE translations SET value = '{\"other\":\"Spielen\"}', qa_errors = 1 WHERE string_id = 2 AND language = 'de'",
    },
  ]);
}

async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

async function counts(sql: Sql) {
  const [rows] = await sql.read([
    {
      sql: "SELECT qa_errors, qa_warnings FROM translations WHERE string_id = 2 AND language = 'de'",
    },
  ]);
  return rows[0];
}

export const LANGUAGE_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "addition rechecks the source language after a settings conflict",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [
              {
                sql: "INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
                params: [JSON.stringify({ ...defaultSettings("test"), sourceLanguage: "it" })],
              },
            ]);
          return rows;
        },
      };
      await rejected(() => addProjectLanguageAsync(changing, ADMIN, "it", OPTIONS), "bad_request");
      const [languages] = await sql.read([{ sql: "SELECT tag FROM languages WHERE tag = 'it'" }]);
      checkEqual([reads, languages], [2, []]);
    },
  },
  {
    name: "plural QA retries use the latest translation value",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [
              {
                sql: 'UPDATE translations SET value = \'{"one":"Spiel","other":"Spiele"}\' WHERE string_id = 2 AND language = \'de\'',
              },
            ]);
          return rows;
        },
      };
      await updateProjectLanguageAsync(
        changing,
        ADMIN,
        "de",
        { pluralOverride: { cardinal: ["one", "other"] } },
        OPTIONS,
      );
      checkEqual([reads, await counts(sql)], [2, { qa_errors: 0, qa_warnings: 0 }]);
    },
  },
  {
    name: "canonical addition and no-op updates preserve language metadata and revision",
    async run(sql) {
      await seed(sql);
      const added = await addProjectLanguageAsync(sql, ADMIN, "pt-br", OPTIONS);
      checkEqual(
        [
          added.language.tag,
          added.language.instructions,
          added.language.pluralOverride,
          added.warnings,
        ],
        ["pt-BR", "", null, []],
      );
      checkEqual(
        await updateProjectLanguageAsync(sql, ADMIN, "PT-br", {}, OPTIONS),
        added.language,
      );
      const [rows, revision] = await sql.read([
        { sql: "SELECT tag, created_at FROM languages WHERE tag = 'pt-BR'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([rows, revision[0].value], [[{ tag: "pt-BR", created_at: 200 }], "4"]);
    },
  },
  {
    name: "source languages, duplicates, invalid tags and missing languages retain errors",
    async run(sql) {
      await seed(sql);
      await rejected(() => addProjectLanguageAsync(sql, ADMIN, "EN", OPTIONS), "bad_request");
      await rejected(() => addProjectLanguageAsync(sql, ADMIN, "DE", OPTIONS), "conflict");
      await rejected(
        () => addProjectLanguageAsync(sql, ADMIN, "not a tag!", OPTIONS),
        "bad_request",
      );
      await rejected(() => updateProjectLanguageAsync(sql, ADMIN, "it", {}, OPTIONS), "not_found");
      await rejected(() => removeProjectLanguageAsync(sql, ADMIN, "it", OPTIONS), "not_found");
      const unsupported = await addProjectLanguageAsync(sql, ADMIN, "zz", OPTIONS);
      checkEqual(unsupported.warnings.length, 1);
    },
  },
  {
    name: "plural overrides update QA and reject missing other without changing instructions",
    async run(sql) {
      await seed(sql);
      await rejected(
        () =>
          updateProjectLanguageAsync(
            sql,
            ADMIN,
            "de",
            { instructions: "Must roll back", pluralOverride: { cardinal: ["one"] } },
            OPTIONS,
          ),
        "bad_request",
      );
      const updated = await updateProjectLanguageAsync(
        sql,
        ADMIN,
        "de",
        { instructions: "Informal", pluralOverride: { cardinal: ["other"] } },
        OPTIONS,
      );
      checkEqual(
        [updated.instructions, updated.categories.cardinal, await counts(sql)],
        ["Informal", ["other"], { qa_errors: 0, qa_warnings: 0 }],
      );
      const reset = await updateProjectLanguageAsync(
        sql,
        ADMIN,
        "de",
        { pluralOverride: {} },
        OPTIONS,
      );
      checkEqual(
        [reset.pluralOverride, reset.categories.cardinal, await counts(sql)],
        [null, ["one", "other"], { qa_errors: 1, qa_warnings: 0 }],
      );
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      await updateProjectLanguageAsync(
        sql,
        ADMIN,
        "de",
        { pluralOverride: null, instructions: "Informal" },
        OPTIONS,
      );
      const [after] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(after, revision);
    },
  },
  {
    name: "removal retains project data and re-addition resets instructions and plural rules",
    async run(sql) {
      await seed(sql);
      await updateProjectLanguageAsync(
        sql,
        ADMIN,
        "de",
        { instructions: "Informal", pluralOverride: { cardinal: ["other"] } },
        OPTIONS,
      );
      const [before] = await sql.read([
        {
          sql: "SELECT (SELECT COUNT(*) FROM translations) AS translations, (SELECT COUNT(*) FROM suggestions) AS suggestions, (SELECT COUNT(*) FROM history) AS history",
        },
      ]);
      checkEqual(await removeProjectLanguageAsync(sql, ADMIN, "DE", OPTIONS), { ok: true });
      const [after] = await sql.read([
        {
          sql: "SELECT (SELECT COUNT(*) FROM translations) AS translations, (SELECT COUNT(*) FROM suggestions) AS suggestions, (SELECT COUNT(*) FROM history) AS history",
        },
      ]);
      checkEqual(after, before);
      checkEqual(await counts(sql), { qa_errors: 0, qa_warnings: 0 });
      const restored = await addProjectLanguageAsync(sql, ADMIN, "de", OPTIONS);
      checkEqual(
        [restored.language.instructions, restored.language.pluralOverride, await counts(sql)],
        ["", null, { qa_errors: 1, qa_warnings: 0 }],
      );
    },
  },
  {
    name: "only administrators and the system may maintain languages",
    async run(sql) {
      await seed(sql);
      await rejected(() => addProjectLanguageAsync(sql, ANONYMOUS, "it", OPTIONS), "unauthorized");
      await rejected(() => addProjectLanguageAsync(sql, MANAGER, "it", OPTIONS), "forbidden");
      await rejected(
        () => updateProjectLanguageAsync(sql, MANAGER, "de", {}, OPTIONS),
        "forbidden",
      );
      await rejected(
        () => removeProjectLanguageAsync(sql, { type: "token", tokenId: 7 }, "de", OPTIONS),
        "forbidden",
      );
      checkEqual((await addProjectLanguageAsync(sql, SYSTEM, "it", OPTIONS)).language.tag, "it");
    },
  },
  {
    name: "competing additions retry and reject the newly existing language",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await addProjectLanguageAsync(sql, SYSTEM, "it", OPTIONS);
          return rows;
        },
      };
      await rejected(() => addProjectLanguageAsync(changing, ADMIN, "IT", OPTIONS), "conflict");
      checkEqual(reads, 2);
    },
  },
  {
    name: "competing patches preserve unrelated instructions and replan plural QA",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await updateProjectLanguageAsync(
              sql,
              SYSTEM,
              "de",
              { instructions: "Concurrent" },
              OPTIONS,
            );
          return rows;
        },
      };
      const language = await updateProjectLanguageAsync(
        changing,
        ADMIN,
        "de",
        { pluralOverride: { cardinal: ["other"] } },
        OPTIONS,
      );
      checkEqual(
        [reads, language.instructions, await counts(sql)],
        [2, "Concurrent", { qa_errors: 0, qa_warnings: 0 }],
      );
    },
  },
  {
    name: "removal rechecks administrator access after demotion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => removeProjectLanguageAsync(changing, ADMIN, "de", OPTIONS), "forbidden");
      const [languages] = await sql.read([{ sql: "SELECT tag FROM languages WHERE tag = 'de'" }]);
      checkEqual([reads, languages], [2, [{ tag: "de" }]]);
    },
  },
  {
    name: "updates stop when a concurrent removal wins",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await removeProjectLanguageAsync(sql, SYSTEM, "de", OPTIONS);
          return rows;
        },
      };
      await rejected(
        () => updateProjectLanguageAsync(changing, ADMIN, "de", { instructions: "Late" }, OPTIONS),
        "not_found",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "failed batches roll back the language, QA counts and revision",
    async run(sql) {
      await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_language_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await updateProjectLanguageAsync(
          failing,
          ADMIN,
          "de",
          { instructions: "Failed", pluralOverride: { cardinal: ["other"] } },
          OPTIONS,
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [language, revision] = await sql.read([
        { sql: "SELECT instructions, plural_override FROM languages WHERE tag = 'de'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [language, revision[0].value, await counts(sql)],
        [[{ instructions: "", plural_override: null }], "3", { qa_errors: 1, qa_warnings: 0 }],
      );
    },
  },
  {
    name: "validated entry points log successful changes once and omit no-op logs",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        clock: () => 200,
        defaultModel: "test",
        logger: {
          info: (message, data) => logs.push([message, data]),
          warn() {},
          error() {},
          debug() {},
        },
      });
      await rejected(() => api.addLanguage(ANONYMOUS, { tag: "" }), "unauthorized");
      await rejected(() => api.addLanguage(ADMIN, { tag: "" }), "validation_failed");
      await api.addLanguage(ADMIN, { tag: "IT" });
      await api.updateLanguage(ADMIN, { tag: "it", instructions: "Informal" });
      await api.updateLanguage(ADMIN, { tag: "it", instructions: "Informal" });
      await api.removeLanguage(ADMIN, { tag: "it" });
      checkEqual(logs, [
        ["Language added", { language: "it", actor: { type: "user", id: 1 } }],
        [
          "Language changed",
          { language: "it", changed: ["instructions"], actor: { type: "user", id: 1 } },
        ],
        ["Language removed", { language: "it", actor: { type: "user", id: 1 } }],
      ]);
    },
  },
];
