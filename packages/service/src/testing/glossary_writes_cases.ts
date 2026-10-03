// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import {
  createGlossaryTermAsync,
  updateGlossaryTermAsync,
  deleteGlossaryTermAsync,
  listGlossaryAsync,
} from "../glossary.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const MANAGER: Actor = { type: "user", userId: 1 };
const REQUEST = {
  term: "  Play  ",
  language: "DE",
  kind: "translate" as const,
  translation: "  Spielen  ",
  note: "  Button  ",
};

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'manager', languages = '[\"de\"]' WHERE id = 1" },
  ]);
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

async function counts(sql: Sql) {
  const [rows] = await sql.read([
    {
      sql: "SELECT qa_errors, qa_warnings FROM translations WHERE string_id = 2 AND language = 'de'",
    },
  ]);
  return rows[0];
}

export const GLOSSARY_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "a failed commit rolls back the term, QA counts and revision together",
    async run(sql) {
      await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_glossary_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await createGlossaryTermAsync(
          failing,
          MANAGER,
          { ...REQUEST, translation: "Falsch" },
          100,
          "test",
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(
        [revision[0].value, (await listGlossaryAsync(sql, {})).terms, await counts(sql)],
        ["3", [], { qa_errors: 0, qa_warnings: 0 }],
      );
    },
  },
  {
    name: "creation and patches preserve normalized metadata and creator attribution",
    async run(sql) {
      await seed(sql);
      const created = await createGlossaryTermAsync(sql, MANAGER, REQUEST, 200, "test");
      checkEqual(created, {
        id: 1,
        term: "Play",
        language: "de",
        kind: "translate",
        translation: "Spielen",
        caseSensitive: false,
        note: "Button",
        createdBy: { type: "user", id: 1, name: "Ada", avatarUrl: null },
        createdAt: 200,
        updatedAt: 200,
      });
      const patched = await updateGlossaryTermAsync(
        sql,
        SYSTEM,
        1,
        { kind: "keep", caseSensitive: true, note: "Brand" },
        300,
        "test",
      );
      checkEqual(patched, {
        ...created,
        kind: "keep",
        translation: null,
        caseSensitive: true,
        note: "Brand",
        updatedAt: 300,
      });
      checkEqual(await deleteGlossaryTermAsync(sql, MANAGER, 1, "test"), { ok: true });
      checkEqual((await listGlossaryAsync(sql, {})).terms, []);
    },
  },
  {
    name: "term changes atomically recompute existing translation warning counts",
    async run(sql) {
      await seed(sql);
      await createGlossaryTermAsync(
        sql,
        SYSTEM,
        { ...REQUEST, translation: "Falsch" },
        200,
        "test",
      );
      checkEqual(await counts(sql), { qa_errors: 0, qa_warnings: 1 });
      await updateGlossaryTermAsync(sql, SYSTEM, 1, { translation: "Spielen" }, 300, "test");
      checkEqual(await counts(sql), { qa_errors: 0, qa_warnings: 0 });
      await updateGlossaryTermAsync(sql, SYSTEM, 1, { kind: "keep" }, 400, "test");
      checkEqual(await counts(sql), { qa_errors: 0, qa_warnings: 1 });
      await deleteGlossaryTermAsync(sql, SYSTEM, 1, "test");
      checkEqual(await counts(sql), { qa_errors: 0, qa_warnings: 0 });
    },
  },
  {
    name: "language-limited managers cannot maintain global or other-language terms",
    async run(sql) {
      await seed(sql);
      await rejected(
        () => createGlossaryTermAsync(sql, ANONYMOUS, REQUEST, 100, "test"),
        "unauthorized",
      );
      await rejected(
        () => createGlossaryTermAsync(sql, { type: "token", tokenId: 7 }, REQUEST, 100, "test"),
        "forbidden",
      );
      await rejected(
        () => createGlossaryTermAsync(sql, MANAGER, { ...REQUEST, language: null }, 100, "test"),
        "forbidden",
      );
      await rejected(
        () => createGlossaryTermAsync(sql, MANAGER, { ...REQUEST, language: "fr" }, 100, "test"),
        "forbidden",
      );
      await createGlossaryTermAsync(sql, MANAGER, REQUEST, 100, "test");
      await rejected(
        () => updateGlossaryTermAsync(sql, MANAGER, 1, { language: "fr" }, 200, "test"),
        "forbidden",
      );
      await updateGlossaryTermAsync(sql, SYSTEM, 1, { language: "fr" }, 200, "test");
      await rejected(
        () => updateGlossaryTermAsync(sql, MANAGER, 1, { language: "de" }, 300, "test"),
        "forbidden",
      );
      await rejected(() => deleteGlossaryTermAsync(sql, MANAGER, 1, "test"), "forbidden");
    },
  },
  {
    name: "invalid terms and normalized duplicates retain their errors without partial writes",
    async run(sql) {
      await seed(sql);
      await rejected(
        () => createGlossaryTermAsync(sql, SYSTEM, { ...REQUEST, term: "  " }, 100, "test"),
        "bad_request",
      );
      await rejected(
        () => createGlossaryTermAsync(sql, SYSTEM, { ...REQUEST, translation: "  " }, 100, "test"),
        "bad_request",
      );
      await createGlossaryTermAsync(sql, SYSTEM, REQUEST, 100, "test");
      await rejected(
        () => createGlossaryTermAsync(sql, SYSTEM, { ...REQUEST, term: "ＰＬＡＹ" }, 200, "test"),
        "conflict",
      );
      await createGlossaryTermAsync(sql, SYSTEM, { ...REQUEST, term: "Hello" }, 200, "test");
      await rejected(
        () => updateGlossaryTermAsync(sql, SYSTEM, 2, { term: "play" }, 300, "test"),
        "conflict",
      );
      await rejected(
        () => updateGlossaryTermAsync(sql, SYSTEM, 2, { translation: " " }, 300, "test"),
        "bad_request",
      );
      await rejected(() => updateGlossaryTermAsync(sql, SYSTEM, 999, {}, 300, "test"), "not_found");
      await rejected(() => deleteGlossaryTermAsync(sql, SYSTEM, 999, "test"), "not_found");
      checkEqual(
        (await listGlossaryAsync(sql, {})).terms.map((term) => term.term),
        ["Hello", "Play"],
      );
    },
  },
  {
    name: "competing creations reallocate IDs and reject a concurrently inserted duplicate",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await createGlossaryTermAsync(sql, SYSTEM, { ...REQUEST, term: "Hello" }, 200, "test");
          return rows;
        },
      };
      checkEqual((await createGlossaryTermAsync(changing, MANAGER, REQUEST, 100, "test")).id, 2);
      checkEqual(reads, 2);
      let duplicateReads = 0;
      const duplicate: Sql = {
        ...sql,
        async read(statements) {
          duplicateReads++;
          const rows = await sql.read(statements);
          if (duplicateReads === 1)
            await createGlossaryTermAsync(sql, SYSTEM, { ...REQUEST, term: "Start" }, 300, "test");
          return rows;
        },
      };
      await rejected(
        () =>
          createGlossaryTermAsync(duplicate, MANAGER, { ...REQUEST, term: "Start" }, 100, "test"),
        "conflict",
      );
      checkEqual(duplicateReads, 2);
    },
  },
  {
    name: "concurrent patches merge against the newest term instead of losing unrelated edits",
    async run(sql) {
      await seed(sql);
      await createGlossaryTermAsync(sql, SYSTEM, REQUEST, 100, "test");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await updateGlossaryTermAsync(
              sql,
              SYSTEM,
              1,
              { note: "Concurrent note", caseSensitive: true },
              200,
              "test",
            );
          return rows;
        },
      };
      const result = await updateGlossaryTermAsync(
        changing,
        MANAGER,
        1,
        { translation: "Spiele" },
        300,
        "test",
      );
      checkEqual(
        [reads, result.note, result.caseSensitive, result.translation],
        [2, "Concurrent note", true, "Spiele"],
      );
    },
  },
  {
    name: "deletion rechecks language scope after a concurrent move",
    async run(sql) {
      await seed(sql);
      await createGlossaryTermAsync(sql, MANAGER, REQUEST, 100, "test");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await updateGlossaryTermAsync(sql, SYSTEM, 1, { language: "fr" }, 200, "test");
          return rows;
        },
      };
      await rejected(() => deleteGlossaryTermAsync(changing, MANAGER, 1, "test"), "forbidden");
      checkEqual([reads, (await listGlossaryAsync(sql, {})).terms[0].language], [2, "fr"]);
    },
  },
  {
    name: "creation rechecks demoted callers before retrying a stale commit",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET role = 'contributor' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(
        () => createGlossaryTermAsync(changing, MANAGER, REQUEST, 100, "test"),
        "forbidden",
      );
      checkEqual([reads, (await listGlossaryAsync(sql, {})).terms], [2, []]);
    },
  },
  {
    name: "QA retries use the latest translation value",
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
                sql: "UPDATE translations SET value = '\"Falsch\"' WHERE string_id = 2 AND language = 'de'",
              },
            ]);
          return rows;
        },
      };
      await createGlossaryTermAsync(changing, MANAGER, REQUEST, 100, "test");
      checkEqual([reads, await counts(sql)], [2, { qa_errors: 0, qa_warnings: 1 }]);
    },
  },
  {
    name: "validated glossary entry points preserve access and input errors",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql, clock: () => 100, defaultModel: "test" });
      await rejected(
        () => api.createGlossaryTerm(ANONYMOUS, { ...REQUEST, term: "" }),
        "unauthorized",
      );
      await rejected(
        () => api.createGlossaryTerm(MANAGER, { ...REQUEST, term: "" }),
        "validation_failed",
      );
      const term = await api.createGlossaryTerm(MANAGER, REQUEST);
      checkEqual(
        (await api.updateGlossaryTerm(MANAGER, { id: term.id, note: "Edited" })).note,
        "Edited",
      );
      checkEqual(await api.deleteGlossaryTerm(MANAGER, { id: term.id }), { ok: true });
    },
  },
];
