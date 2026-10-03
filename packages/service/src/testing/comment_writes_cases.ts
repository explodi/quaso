// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import {
  addCommentAsync,
  deleteCommentAsync,
  listCommentsAsync,
  resolveCommentAsync,
} from "../comments.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const AUTHOR: Actor = { type: "user", userId: 1 };
const REVIEWER: Actor = { type: "user", userId: 2 };
const ADMIN: Actor = { type: "user", userId: 3 };
const REQUEST = { body: "  A comment  ", language: "DE", sourceIssue: false };

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'contributor' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager', languages = '[\"de\"]' WHERE id = 2" },
    {
      sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (3, 'Admin', 'administrator', 100)",
    },
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

export const COMMENT_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "create, resolve and soft delete preserve body, language and user attribution",
    async run(sql) {
      await seed(sql);
      const created = await addCommentAsync(sql, AUTHOR, 1, REQUEST, 100);
      checkEqual(created, {
        id: 1,
        stringId: 1,
        file: "common.json",
        key: "title",
        language: "de",
        body: "A comment",
        sourceIssue: false,
        resolvedAt: null,
        resolvedBy: null,
        author: { type: "user", id: 1, name: "Ada", avatarUrl: null },
        createdAt: 100,
      });
      const resolved = await resolveCommentAsync(sql, REVIEWER, created.id, 200);
      checkEqual(
        [resolved.resolvedAt, resolved.resolvedBy],
        [200, { type: "user", id: 2, name: "Reviewer", avatarUrl: null }],
      );
      checkEqual(await resolveCommentAsync(sql, SYSTEM, created.id, 300), resolved);
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(revision[0].value, "5");
      checkEqual(await deleteCommentAsync(sql, AUTHOR, created.id, 400), { ok: true });
      checkEqual((await listCommentsAsync(sql, ANONYMOUS, { stringId: 1 })).total, 0);
      const [stored] = await sql.read([
        { sql: "SELECT body, deleted_at FROM comments WHERE id = 1" },
      ]);
      checkEqual(stored, [{ body: "A comment", deleted_at: 400 }]);
      await rejected(() => resolveCommentAsync(sql, SYSTEM, created.id, 500), "not_found");
      await rejected(() => deleteCommentAsync(sql, SYSTEM, created.id, 500), "not_found");
    },
  },
  {
    name: "owners, reviewers and administrators retain their distinct rights",
    async run(sql) {
      await seed(sql);
      await rejected(() => addCommentAsync(sql, ANONYMOUS, 1, REQUEST, 100), "unauthorized");
      await rejected(
        () => addCommentAsync(sql, { type: "token", tokenId: 7 }, 1, REQUEST, 100),
        "forbidden",
      );
      const comment = await addCommentAsync(sql, AUTHOR, 1, { ...REQUEST, language: "fr" }, 100);
      await rejected(() => resolveCommentAsync(sql, REVIEWER, comment.id, 200), "forbidden");
      await rejected(() => deleteCommentAsync(sql, REVIEWER, comment.id, 200), "forbidden");
      checkEqual((await resolveCommentAsync(sql, AUTHOR, comment.id, 200)).resolvedAt, 200);
      checkEqual(await deleteCommentAsync(sql, ADMIN, comment.id, 300), { ok: true });
      const system = await addCommentAsync(
        sql,
        SYSTEM,
        1,
        { body: "Source problem", language: "unknown", sourceIssue: true },
        400,
      );
      checkEqual(
        [system.language, system.sourceIssue, system.author],
        [null, true, { type: "system", id: null, name: "System" }],
      );
    },
  },
  {
    name: "new comments require active translatable strings, nonblank bodies and allowed project languages",
    async run(sql) {
      await seed(sql);
      await rejected(() => addCommentAsync(sql, AUTHOR, 5, REQUEST, 100), "not_found");
      await rejected(() => addCommentAsync(sql, AUTHOR, 999, REQUEST, 100), "not_found");
      await rejected(
        () => addCommentAsync(sql, AUTHOR, 1, { ...REQUEST, body: " \n " }, 100),
        "bad_request",
      );
      await rejected(
        () => addCommentAsync(sql, AUTHOR, 1, { ...REQUEST, language: "xx" }, 100),
        "bad_request",
      );
      await sql.commit(3, [{ sql: "UPDATE users SET languages = '[\"de\"]' WHERE id = 1" }]);
      await rejected(
        () => addCommentAsync(sql, AUTHOR, 1, { ...REQUEST, language: "fr" }, 100),
        "forbidden",
      );
      await sql.commit(4, [{ sql: "UPDATE files SET active = 0 WHERE path = 'common.json'" }]);
      await rejected(() => addCommentAsync(sql, AUTHOR, 1, REQUEST, 100), "not_found");
    },
  },
  {
    name: "pending volunteers may discuss strings and retain ownership",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [
        { sql: "UPDATE users SET role = 'none', volunteer_status = 'pending' WHERE id = 1" },
      ]);
      const comment = await addCommentAsync(sql, AUTHOR, 1, REQUEST, 100);
      checkEqual((await resolveCommentAsync(sql, AUTHOR, comment.id, 200)).resolvedAt, 200);
      checkEqual(await deleteCommentAsync(sql, AUTHOR, comment.id, 300), { ok: true });
    },
  },
  {
    name: "competing additions allocate distinct IDs after a conflict",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await addCommentAsync(sql, SYSTEM, 1, { body: "Other", sourceIssue: false }, 200);
          return rows;
        },
      };
      const created = await addCommentAsync(changing, AUTHOR, 1, REQUEST, 100);
      checkEqual([reads, created.id], [2, 2]);
      checkEqual(
        (await listCommentsAsync(sql, ANONYMOUS, { stringId: 1 })).comments.map(
          (comment) => comment.body,
        ),
        ["A comment", "Other"],
      );
    },
  },
  {
    name: "a removed language during creation prevents a stale comment commit",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await sql.commit(3, [{ sql: "DELETE FROM languages WHERE tag = 'de'" }]);
          return rows;
        },
      };
      await rejected(() => addCommentAsync(changing, AUTHOR, 1, REQUEST, 100), "bad_request");
      const [rows] = await sql.read([{ sql: "SELECT id FROM comments" }]);
      checkEqual([reads, rows], [2, []]);
    },
  },
  {
    name: "a reviewer demotion during resolution is checked again on retry",
    async run(sql) {
      await seed(sql);
      const comment = await addCommentAsync(sql, AUTHOR, 1, REQUEST, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(4, [{ sql: "UPDATE users SET role = 'none' WHERE id = 2" }]);
          return rows;
        },
      };
      await rejected(() => resolveCommentAsync(changing, REVIEWER, comment.id, 200), "forbidden");
      checkEqual(
        [reads, (await listCommentsAsync(sql, ANONYMOUS, { stringId: 1 })).comments[0].resolvedAt],
        [2, null],
      );
    },
  },
  {
    name: "competing resolutions preserve the first resolver and skip a second commit",
    async run(sql) {
      await seed(sql);
      const comment = await addCommentAsync(sql, AUTHOR, 1, REQUEST, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await resolveCommentAsync(sql, AUTHOR, comment.id, 150);
          return rows;
        },
      };
      const resolved = await resolveCommentAsync(changing, REVIEWER, comment.id, 200);
      checkEqual([reads, resolved.resolvedAt, resolved.resolvedBy?.id], [2, 150, 1]);
    },
  },
  {
    name: "an administrator demotion during deletion preserves the comment",
    async run(sql) {
      await seed(sql);
      const comment = await addCommentAsync(sql, AUTHOR, 1, REQUEST, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(4, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 3" }]);
          return rows;
        },
      };
      await rejected(() => deleteCommentAsync(changing, ADMIN, comment.id, 200), "forbidden");
      checkEqual([reads, (await listCommentsAsync(sql, ANONYMOUS, { stringId: 1 })).total], [2, 1]);
    },
  },
  {
    name: "validated comment entry points retain input and permission errors",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql, clock: () => 100 });
      await rejected(() => api.addComment(ANONYMOUS, { stringId: 0, ...REQUEST }), "unauthorized");
      await rejected(
        () => api.addComment(AUTHOR, { stringId: 0, ...REQUEST }),
        "validation_failed",
      );
      const comment = await api.addComment(AUTHOR, { stringId: 1, ...REQUEST });
      checkEqual((await api.resolveComment(REVIEWER, { id: comment.id })).resolvedAt, 100);
      checkEqual(await api.deleteComment(AUTHOR, { id: comment.id }), { ok: true });
    },
  },
];
