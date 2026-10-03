// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { updateFileAsync, updateStringAsync } from "../metadata_writes.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager' WHERE id = 2" },
    { sql: "UPDATE files SET generated_context = 'Generated' WHERE id = 1" },
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

async function qa(sql: Sql) {
  const [rows] = await sql.read([
    { sql: "SELECT string_id, qa_errors, qa_warnings FROM translations ORDER BY string_id" },
  ]);
  return rows;
}

export const METADATA_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "file context preserves generated context and unchanged patches skip writes",
    async run(sql) {
      await seed(sql);
      const file = await updateFileAsync(sql, MANAGER, 1, { context: "Menus" }, 200);
      checkEqual(file, {
        id: 1,
        path: "common.json",
        context: "Menus",
        generatedContext: "Generated",
      });
      const noWrites: Sql = {
        ...sql,
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(await updateFileAsync(noWrites, MANAGER, 1, {}, 300), file);
      checkEqual(await updateFileAsync(noWrites, MANAGER, 1, { context: "Menus" }, 300), file);
      const [stored, revision] = await sql.read([
        { sql: "SELECT context, generated_context, updated_at FROM files WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [stored, revision[0].value],
        [[{ context: "Menus", generated_context: "Generated", updated_at: 200 }], "4"],
      );
    },
  },
  {
    name: "string limits update only that string's QA and can be cleared",
    async run(sql) {
      await seed(sql);
      checkEqual(
        await updateStringAsync(
          sql,
          ADMIN,
          2,
          { description: "Button", maxLength: 3 },
          200,
          "test",
        ),
        { id: 2, description: "Button", maxLength: 3, maxLengthLocked: false },
      );
      checkEqual(await qa(sql), [
        { string_id: 1, qa_errors: 1, qa_warnings: 0 },
        { string_id: 2, qa_errors: 1, qa_warnings: 0 },
      ]);
      checkEqual(
        (await updateStringAsync(sql, ADMIN, 2, { maxLength: null }, 300, "test")).maxLength,
        null,
      );
      checkEqual(await qa(sql), [
        { string_id: 1, qa_errors: 1, qa_warnings: 0 },
        { string_id: 2, qa_errors: 0, qa_warnings: 0 },
      ]);
      const noWrites: Sql = {
        ...sql,
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(
        await updateStringAsync(
          noWrites,
          ADMIN,
          2,
          { description: "Button", maxLength: null },
          400,
          "test",
        ),
        { id: 2, description: "Button", maxLength: null, maxLengthLocked: false },
      );
      const [stored] = await sql.read([{ sql: "SELECT updated_at FROM strings WHERE id = 2" }]);
      checkEqual(stored, [{ updated_at: 300 }]);
    },
  },
  {
    name: "CLI limits allow descriptions and identical values but reject changed limits atomically",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [
        { sql: "UPDATE strings SET max_length = 7, max_length_locked = 1 WHERE id = 2" },
      ]);
      checkEqual(
        await updateStringAsync(
          sql,
          ADMIN,
          2,
          { description: "Button", maxLength: 7 },
          200,
          "test",
        ),
        { id: 2, description: "Button", maxLength: 7, maxLengthLocked: true },
      );
      await rejected(
        () =>
          updateStringAsync(
            sql,
            ADMIN,
            2,
            { description: "Must not save", maxLength: null },
            300,
            "test",
          ),
        "bad_request",
      );
      const [stored] = await sql.read([
        { sql: "SELECT description, max_length FROM strings WHERE id = 2" },
      ]);
      checkEqual(stored, [{ description: "Button", max_length: 7 }]);
    },
  },
  {
    name: "file and string permissions, missing IDs and copied strings preserve errors",
    async run(sql) {
      await seed(sql);
      await rejected(() => updateFileAsync(sql, ANONYMOUS, 1, {}, 200), "unauthorized");
      await rejected(
        () => updateFileAsync(sql, { type: "token", tokenId: 7 }, 1, {}, 200),
        "forbidden",
      );
      await rejected(() => updateStringAsync(sql, MANAGER, 2, {}, 200, "test"), "forbidden");
      await rejected(() => updateStringAsync(sql, ANONYMOUS, 2, {}, 200, "test"), "unauthorized");
      await rejected(() => updateFileAsync(sql, ADMIN, 999, {}, 200), "not_found");
      await rejected(() => updateStringAsync(sql, ADMIN, 999, {}, 200, "test"), "not_found");
      await rejected(() => updateStringAsync(sql, ADMIN, 5, {}, 200, "test"), "not_found");
    },
  },
  {
    name: "inactive project metadata remains editable for later reactivation",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [
        { sql: "UPDATE files SET active = 0 WHERE id = 1" },
        { sql: "UPDATE strings SET active = 0 WHERE id = 2" },
      ]);
      checkEqual(
        (await updateFileAsync(sql, ADMIN, 1, { context: "Hidden" }, 200)).context,
        "Hidden",
      );
      checkEqual(
        (await updateStringAsync(sql, ADMIN, 2, { description: "Hidden" }, 200, "test"))
          .description,
        "Hidden",
      );
    },
  },
  {
    name: "concurrent file updates return the latest generated context after retry",
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
              { sql: "UPDATE files SET generated_context = 'New generated' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      const file = await updateFileAsync(changing, MANAGER, 1, { context: "Menus" }, 200);
      checkEqual([reads, file.context, file.generatedContext], [2, "Menus", "New generated"]);
    },
  },
  {
    name: "concurrent string patches preserve unrelated descriptions",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await updateStringAsync(sql, SYSTEM, 2, { description: "Concurrent" }, 150, "test");
          return rows;
        },
      };
      const string = await updateStringAsync(changing, ADMIN, 2, { maxLength: 3 }, 200, "test");
      checkEqual([reads, string.description, string.maxLength], [2, "Concurrent", 3]);
    },
  },
  {
    name: "a CLI lock acquired during the read prevents a stale limit update",
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
              { sql: "UPDATE strings SET max_length = 7, max_length_locked = 1 WHERE id = 2" },
            ]);
          return rows;
        },
      };
      await rejected(
        () =>
          updateStringAsync(changing, ADMIN, 2, { description: "Late", maxLength: 3 }, 200, "test"),
        "bad_request",
      );
      const [stored] = await sql.read([
        { sql: "SELECT description, max_length FROM strings WHERE id = 2" },
      ]);
      checkEqual([reads, stored], [2, [{ description: "", max_length: 7 }]]);
    },
  },
  {
    name: "file context rechecks manager rights after a demotion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET role = 'contributor' WHERE id = 2" }]);
          return rows;
        },
      };
      await rejected(
        () => updateFileAsync(changing, MANAGER, 1, { context: "Late" }, 200),
        "forbidden",
      );
      const [stored] = await sql.read([{ sql: "SELECT context FROM files WHERE id = 1" }]);
      checkEqual([reads, stored], [2, [{ context: "" }]]);
    },
  },
  {
    name: "limit QA retries use concurrent translation values",
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
                sql: "UPDATE translations SET value = '\"A\"' WHERE string_id = 2 AND language = 'de'",
              },
            ]);
          return rows;
        },
      };
      await updateStringAsync(changing, ADMIN, 2, { maxLength: 3 }, 200, "test");
      checkEqual(
        [reads, await qa(sql)],
        [
          2,
          [
            { string_id: 1, qa_errors: 1, qa_warnings: 0 },
            { string_id: 2, qa_errors: 0, qa_warnings: 0 },
          ],
        ],
      );
    },
  },
  {
    name: "failed metadata batches roll back the description, limit, QA and revision",
    async run(sql) {
      await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_metadata_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await updateStringAsync(
          failing,
          ADMIN,
          2,
          { description: "Failed", maxLength: 3 },
          200,
          "test",
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [stored, revision] = await sql.read([
        { sql: "SELECT description, max_length FROM strings WHERE id = 2" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [stored, revision[0].value, await qa(sql)],
        [
          [{ description: "", max_length: null }],
          "3",
          [
            { string_id: 1, qa_errors: 1, qa_warnings: 0 },
            { string_id: 2, qa_errors: 0, qa_warnings: 0 },
          ],
        ],
      );
    },
  },
  {
    name: "validated metadata entry points preserve access and input errors",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql, clock: () => 200, defaultModel: "test" });
      await rejected(() => api.updateFile(ANONYMOUS, { id: 0 }), "unauthorized");
      await rejected(() => api.updateFile(MANAGER, { id: 0 }), "validation_failed");
      await rejected(() => api.updateString(MANAGER, { id: 0 }), "forbidden");
      await rejected(() => api.updateString(ADMIN, { id: 2, maxLength: -1 }), "validation_failed");
      checkEqual((await api.updateFile(MANAGER, { id: 1, context: "Menus" })).context, "Menus");
      checkEqual((await api.updateString(ADMIN, { id: 2, maxLength: 3 })).maxLength, 3);
    },
  },
];
