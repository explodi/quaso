// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { listCommentsAsync } from "../comments.ts";
import { ServiceError } from "../errors.ts";
import {
  ACTIONS,
  readPermissions,
  permissionReadStatements,
  permissionsFromRows,
  type Action,
} from "../permissions.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const MANAGER: Actor = { type: "user", userId: 3 };
const CONTRIBUTOR: Actor = { type: "user", userId: 2 };
const PENDING: Actor = { type: "user", userId: 5 };

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'none', languages = NULL WHERE id = 1" },
    { sql: "UPDATE users SET role = 'contributor', languages = '[\"pt-BR\"]' WHERE id = 2" },
    {
      sql: `INSERT INTO users (id, display_name, role, languages, volunteer_status, created_at, deleted_at) VALUES
      (3, 'Manager', 'manager', '["de"]', NULL, 100, NULL), (4, 'Admin', 'administrator', '[]', NULL, 100, NULL),
      (5, 'Pending', 'none', NULL, 'pending', 100, NULL), (6, 'Deleted', 'administrator', NULL, NULL, 100, 101)`,
    },
    {
      sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_at, revoked_at) VALUES (8, 'Upload', 'upload', 'upload', 'qso_', 100, NULL), (9, 'Revoked', 'upload', 'revoked', 'qso_', 100, 101)",
    },
    {
      sql: `INSERT INTO comments (id, string_id, language, body, source_issue, resolved_at, resolved_by, author_id, created_at, deleted_at)
      SELECT 100, id, NULL, 'Source issue', 1, NULL, NULL, 1, 100, NULL FROM strings WHERE display_key = 'title'`,
    },
    {
      sql: `INSERT INTO comments (id, string_id, language, body, source_issue, resolved_at, resolved_by, author_id, created_at, deleted_at)
      SELECT 101, id, 'de', 'Resolved', 0, 101, 3, 2, 100, NULL FROM strings WHERE display_key = 'title'`,
    },
    {
      sql: `INSERT INTO comments (id, string_id, language, body, source_issue, author_id, created_at)
      SELECT 102, id, 'fr', 'French', 0, NULL, 100 FROM strings WHERE display_key = 'title'`,
    },
    {
      sql: `INSERT INTO comments (id, string_id, language, body, source_issue, author_id, created_at, deleted_at)
      SELECT 103, id, NULL, 'Deleted', 1, 1, 100, 101 FROM strings WHERE display_key = 'title'`,
    },
  ]);
}

async function titleId(sql: Sql): Promise<number> {
  const [rows] = await sql.read([{ sql: "SELECT id FROM strings WHERE display_key = 'title'" }]);
  return Number(rows[0].id);
}

async function rejected(run: () => unknown | Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

export const ACCESS_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "system and anonymous permissions require no database read",
    async run(sql) {
      const noReads: Sql = {
        ...sql,
        read: async () => {
          throw new Error("No identity rows needed");
        },
      };
      const system = await readPermissions(noReads, SYSTEM);
      const anonymous = await readPermissions(noReads, ANONYMOUS);
      checkEqual(
        ACTIONS.filter((action) => system.can(action)),
        [...ACTIONS],
      );
      checkEqual(
        ACTIONS.filter((action) => anonymous.can(action)),
        ["read"],
      );
      checkEqual([system.languageLimit(), anonymous.languageLimit()], [null, null]);
      await rejected(() => anonymous.require("download"), "unauthorized");
    },
  },
  {
    name: "roles preserve their action sets and canonical language restrictions",
    async run(sql) {
      await seed(sql);
      const none = await readPermissions(sql, { type: "user", userId: 1 });
      const contributor = await readPermissions(sql, CONTRIBUTOR);
      const manager = await readPermissions(sql, MANAGER);
      const admin = await readPermissions(sql, { type: "user", userId: 4 });
      checkEqual(
        ACTIONS.filter((action) => none.can(action)),
        ["read", "volunteer", "account", "requestLanguage"],
      );
      checkEqual(
        ACTIONS.filter((action) => contributor.can(action)),
        ["read", "suggest", "account", "comment", "requestLanguage"],
      );
      checkEqual(
        ACTIONS.filter((action) => manager.can(action)),
        [
          "read",
          "translate",
          "review",
          "edit",
          "suggest",
          "account",
          "usage",
          "context",
          "glossary",
          "comment",
          "requestLanguage",
          "issues",
        ],
      );
      checkEqual(
        ACTIONS.filter((action) => admin.can(action)),
        ACTIONS.filter((action) => action !== "volunteer"),
      );
      checkEqual(
        [
          contributor.can("suggest", "pt-br"),
          contributor.can("suggest", "de"),
          manager.can("edit", "DE"),
          manager.can("edit", "fr"),
          manager.can("translate", "fr"),
          admin.can("edit", "fr"),
        ],
        [true, false, true, false, true, true],
      );
      checkEqual(
        [contributor.languageLimit(), manager.languageLimit(), admin.languageLimit()],
        [["pt-BR"], ["de"], null],
      );
      await rejected(() => contributor.require("issues"), "forbidden");
      const limited: Action[] = ["suggest", "edit", "review", "glossary", "comment"];
      checkEqual(
        limited.map((action) => manager.can(action, "fr")),
        [false, false, false, false, false],
      );
    },
  },
  {
    name: "key scopes and revoked or missing keys preserve all action decisions",
    async run(sql) {
      await seed(sql);
      const read = await readPermissions(sql, { type: "token", tokenId: 7 });
      const upload = await readPermissions(sql, { type: "token", tokenId: 8 });
      const revoked = await readPermissions(sql, { type: "token", tokenId: 9 });
      const missing = await readPermissions(sql, { type: "token", tokenId: 999 });
      checkEqual(
        ACTIONS.filter((action) => read.can(action)),
        ["read", "download"],
      );
      checkEqual(
        ACTIONS.filter((action) => upload.can(action)),
        ["read", "download", "upload", "translate", "usage"],
      );
      checkEqual(
        ACTIONS.filter((action) => revoked.can(action)),
        [],
      );
      checkEqual(
        ACTIONS.filter((action) => missing.can(action)),
        [],
      );
      checkEqual(upload.languageLimit(), null);
    },
  },
  {
    name: "pending volunteers may comment while deleted and unknown users only read",
    async run(sql) {
      await seed(sql);
      const pending = await readPermissions(sql, PENDING);
      const deleted = await readPermissions(sql, { type: "user", userId: 6 });
      const missing = await readPermissions(sql, { type: "user", userId: 999 });
      checkEqual(
        [pending.can("comment"), pending.can("comment", "fr"), pending.can("edit")],
        [true, true, false],
      );
      checkEqual(
        ACTIONS.filter((action) => deleted.can(action)),
        ["read"],
      );
      checkEqual(
        ACTIONS.filter((action) => missing.can(action)),
        ["read"],
      );
      checkEqual(deleted.languageLimit(), null);
    },
  },
  {
    name: "permission rows can share a batch with operation data",
    async run(sql) {
      await seed(sql);
      const [revision, ...rows] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ...permissionReadStatements(MANAGER),
      ]);
      await sql.commit(3, [{ sql: "UPDATE users SET role = 'none' WHERE id = 3" }]);
      checkEqual(revision, [{ value: "3" }]);
      checkEqual(permissionsFromRows(MANAGER, rows).can("issues"), true);
      checkEqual((await readPermissions(sql, MANAGER)).can("issues"), false);
    },
  },
  {
    name: "comment pages include source context, identities and exclusive offset pages",
    async run(sql) {
      await seed(sql);
      const id = await titleId(sql);
      const page = await listCommentsAsync(sql, ANONYMOUS, {
        stringId: id,
        language: "DE",
        limit: 1,
      });
      checkEqual([page.total, page.nextCursor, page.comments[0].id], [2, "1", 101]);
      checkEqual(
        [
          page.comments[0].author.name,
          page.comments[0].resolvedBy?.name,
          page.comments[0].sourceIssue,
        ],
        ["Reviewer", "Manager", false],
      );
      const next = await listCommentsAsync(sql, ANONYMOUS, {
        stringId: id,
        language: "de",
        cursor: page.nextCursor!,
      });
      checkEqual(
        [next.comments[0].id, next.nextCursor, next.comments[0].body],
        [100, null, "Source issue"],
      );
      const all = await listCommentsAsync(sql, SYSTEM, { stringId: id });
      checkEqual(
        all.comments.map((comment) => comment.id),
        [102, 101, 100],
      );
      checkEqual(all.comments[0].author, { type: "system", id: null, name: "System" });
    },
  },
  {
    name: "comment state filters compose and managers alone can browse source issues",
    async run(sql) {
      await seed(sql);
      const id = await titleId(sql);
      checkEqual(
        (
          await listCommentsAsync(sql, ANONYMOUS, {
            stringId: id,
            resolved: false,
            sourceIssue: false,
          })
        ).comments.map((comment) => comment.id),
        [102],
      );
      checkEqual(
        (await listCommentsAsync(sql, MANAGER, {})).comments.map((comment) => comment.id),
        [100],
      );
      await rejected(() => listCommentsAsync(sql, ANONYMOUS, {}), "unauthorized");
      await rejected(() => listCommentsAsync(sql, CONTRIBUTOR, {}), "forbidden");
      await rejected(
        () => listCommentsAsync(sql, { type: "token", tokenId: 9 }, { stringId: id }),
        "forbidden",
      );
    },
  },
  {
    name: "comment reads reject invalid cursors, unknown languages and hidden strings",
    async run(sql) {
      await seed(sql);
      const id = await titleId(sql);
      await rejected(
        () => listCommentsAsync(sql, ANONYMOUS, { stringId: id, cursor: "1 OR 1=1" }),
        "bad_request",
      );
      await rejected(
        () => listCommentsAsync(sql, ANONYMOUS, { stringId: id, language: "es" }),
        "not_found",
      );
      await rejected(() => listCommentsAsync(sql, ANONYMOUS, { stringId: 999 }), "not_found");
      await sql.commit(3, [{ sql: "UPDATE strings SET active = 0 WHERE id = ?", params: [id] }]);
      await rejected(() => listCommentsAsync(sql, ANONYMOUS, { stringId: id }), "not_found");
    },
  },
  {
    name: "issue permissions and author names remain in one snapshot across a demotion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(3, [
            { sql: "UPDATE users SET role = 'none', display_name = 'Changed' WHERE id = 3" },
            { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 1" },
          ]);
          return rows;
        },
      };
      const page = await listCommentsAsync(changing, MANAGER, {});
      checkEqual([reads, page.comments.length, page.comments[0].author.name], [1, 1, "Ada"]);
      await rejected(() => listCommentsAsync(sql, MANAGER, {}), "forbidden");
    },
  },
];
