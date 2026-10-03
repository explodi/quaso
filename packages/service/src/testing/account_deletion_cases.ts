// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { completeAccountDeletionAsync, deleteAccountAsync } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import { getHistoryAsync } from "../history.ts";
import { hashPassword } from "../passwords.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const USER: Actor = { type: "user", userId: 1 };
const PASSWORD = "Long password";
const OPTIONS = { secretKey: "test-secret", iterations: 10 };

async function seed(sql: Sql) {
  const hash = await hashPassword(PASSWORD, OPTIONS);
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, avatar_url, role, languages, password_hash, email_verified, volunteer_status, volunteer_languages, volunteer_message, volunteer_requested_at, created_at) VALUES (1, 'ada@example.com', 'Ada', 'https://example.com/avatar', 'contributor', '[\"de\"]', ?, 1, 'approved', '[\"de\"]', 'Hello', 100, 100), (2, 'other@example.com', 'Other', NULL, 'administrator', NULL, NULL, 1, NULL, NULL, NULL, NULL, 100)",
      params: [hash],
    },
    {
      sql: "INSERT INTO files (id, path, repo_path, format, created_at, updated_at) VALUES (1, 'a.json', 'a.json', '{}', 100, 100)",
    },
    {
      sql: "INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source, source_hash, search_text, position, created_at, updated_at) VALUES (1, 1, 'title', '[\"title\"]', 'title', 'text', '\"Hello\"', 'source-hash', 'hello', 0, 100, 100)",
    },
    {
      sql: "INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, status, author_type, author_id, created_at) VALUES (1, 1, 'de', 'translation', '\"Hallo\"', 'source-hash', 0, 'pending', 'user', 1, 100), (2, 1, 'de', 'approval', NULL, 'source-hash', 0, 'pending', 'user', 1, 100), (3, 1, 'de', 'translation', '\"Other\"', 'source-hash', 0, 'pending', 'user', 2, 100), (4, 1, 'de', 'translation', '\"Saved\"', 'source-hash', 0, 'approved', 'user', 1, 100)",
    },
    {
      sql: "INSERT INTO history (id, string_id, language, event, after_value, actor_type, actor_id, created_at) VALUES (1, 1, 'de', 'translation_saved', '\"Hallo\"', 'user', 1, 100)",
    },
    {
      sql: "INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, author_id, revision, search_text, created_at, updated_at) VALUES (1, 'de', '\"Hallo\"', 'blue', 'source-hash', 'user', 1, 1, 'hallo', 100, 100)",
    },
    {
      sql: "INSERT INTO activity (id, type, actor_type, actor_id, summary, detail, created_at) VALUES (1, 'review', 'user', 2, 'Volunteer approved: Ada, as contributor (de)', '{\"kind\":\"volunteer\",\"userId\":1}', 100), (2, 'review', 'user', 2, 'Volunteer request declined: Ada', '{\"kind\":\"volunteer\",\"userId\":1}', 100), (3, 'review', 'user', 2, 'Volunteer approved: Other, as administrator', '{\"kind\":\"volunteer\",\"userId\":2}', 100), (4, 'review', 'user', 2, 'Unrelated review', '{\"kind\":\"other\",\"note\":\"volunteer\"}', 100)",
    },
    {
      sql: "INSERT INTO identities (user_id, provider, subject, created_at) VALUES (1, 'github', 'ada-subject', 100), (2, 'github', 'other-subject', 100)",
    },
    {
      sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('own-one', 1, 100, 500, 100), ('own-two', 1, 100, 500, 100), ('foreign', 2, 100, 500, 100)",
    },
    {
      sql: "INSERT INTO email_tokens (token_hash, user_id, email, purpose, expires_at, created_at) VALUES ('own', 1, 'ada@example.com', 'reset', 500, 100), ('foreign', 2, 'other@example.com', 'reset', 500, 100)",
    },
    {
      sql: "INSERT INTO invites (id, token_hash, role, created_by, created_at, expires_at, used_at, revoked_at) VALUES (1, 'unused', 'contributor', 1, 100, 500, NULL, NULL), (2, 'used', 'contributor', 1, 100, 500, 150, NULL), (3, 'revoked', 'contributor', 1, 100, 500, NULL, 150), (4, 'foreign', 'contributor', 2, 100, 500, NULL, NULL)",
    },
  ]);
  return hash;
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

export const ACCOUNT_DELETION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "deletion anonymizes the person and removes only their credentials, sessions and links",
    async run(sql) {
      await seed(sql);
      checkEqual(
        await deleteAccountAsync(
          sql,
          USER,
          { confirm: "delete", password: PASSWORD },
          OPTIONS,
          200,
        ),
        { ok: true },
      );
      const [users, identities, sessions, tokens, invites] = await sql.read([
        {
          sql: "SELECT email, display_name, avatar_url, role, languages, password_hash, email_verified, volunteer_status, volunteer_languages, volunteer_message, volunteer_requested_at, created_at, deleted_at FROM users WHERE id = 1",
        },
        { sql: "SELECT user_id FROM identities" },
        { sql: "SELECT user_id FROM sessions" },
        { sql: "SELECT user_id FROM email_tokens" },
        { sql: "SELECT id, revoked_at FROM invites ORDER BY id" },
      ]);
      checkEqual(users, [
        {
          email: null,
          display_name: "Deleted user",
          avatar_url: null,
          role: "none",
          languages: null,
          password_hash: null,
          email_verified: 0,
          volunteer_status: null,
          volunteer_languages: null,
          volunteer_message: null,
          volunteer_requested_at: null,
          created_at: 100,
          deleted_at: 200,
        },
      ]);
      checkEqual(
        [identities, sessions, tokens],
        [[{ user_id: 2 }], [{ user_id: 2 }], [{ user_id: 2 }]],
      );
      checkEqual(invites, [
        { id: 1, revoked_at: 200 },
        { id: 2, revoked_at: null },
        { id: 3, revoked_at: 150 },
        { id: 4, revoked_at: null },
      ]);
    },
  },
  {
    name: "deletion withdraws own pending suggestions with history and keeps saved work",
    async run(sql) {
      const hash = await seed(sql);
      await completeAccountDeletionAsync(sql, USER, hash, 200);
      const [suggestions, history, translations, activity] = await sql.read([
        { sql: "SELECT id, status, reviewed_at FROM suggestions ORDER BY id" },
        {
          sql: "SELECT event, before_value, after_value, actor_type, actor_id, detail, created_at FROM history ORDER BY id",
        },
        { sql: "SELECT value, author_id FROM translations" },
        { sql: "SELECT summary FROM activity ORDER BY id" },
      ]);
      checkEqual(suggestions, [
        { id: 1, status: "withdrawn", reviewed_at: 200 },
        { id: 2, status: "withdrawn", reviewed_at: 200 },
        { id: 3, status: "pending", reviewed_at: null },
        { id: 4, status: "approved", reviewed_at: null },
      ]);
      checkEqual(history, [
        {
          event: "translation_saved",
          before_value: null,
          after_value: '"Hallo"',
          actor_type: "user",
          actor_id: 1,
          detail: null,
          created_at: 100,
        },
        {
          event: "suggestion_withdrawn",
          before_value: '"Hallo"',
          after_value: null,
          actor_type: "user",
          actor_id: 1,
          detail: '{"suggestionId":1}',
          created_at: 200,
        },
        {
          event: "suggestion_withdrawn",
          before_value: null,
          after_value: null,
          actor_type: "user",
          actor_id: 1,
          detail: '{"suggestionId":2}',
          created_at: 200,
        },
      ]);
      checkEqual(translations, [{ value: '"Hallo"', author_id: 1 }]);
      checkEqual(activity, [
        { summary: "Volunteer approved: Deleted user, as contributor (de)" },
        { summary: "Volunteer request declined: Deleted user" },
        { summary: "Volunteer approved: Other, as administrator" },
        { summary: "Unrelated review" },
      ]);
      const displayed = await getHistoryAsync(sql, 1, "de");
      checkEqual(displayed.entries[0].actor.name, "Deleted user");
      checkEqual(displayed.entries[0].actor.avatarUrl, null);
    },
  },
  {
    name: "passwordless deletion needs no password configuration; protected accounts require a correct password",
    async run(sql) {
      await seed(sql);
      await rejected(
        () => deleteAccountAsync(sql, USER, { confirm: "delete" }, undefined, 200),
        "internal",
      );
      await rejected(
        () => deleteAccountAsync(sql, USER, { confirm: "delete" }, OPTIONS, 200),
        "bad_request",
      );
      await rejected(
        () => deleteAccountAsync(sql, USER, { confirm: "delete", password: "wrong" }, OPTIONS, 200),
        "forbidden",
      );
      await sql.commit(1, [{ sql: "UPDATE users SET password_hash = NULL WHERE id = 1" }]);
      checkEqual(await deleteAccountAsync(sql, USER, { confirm: "delete" }, undefined, 200), {
        ok: true,
      });
    },
  },
  {
    name: "the last active administrator cannot delete their account even with deleted administrators present",
    async run(sql) {
      const hash = await seed(sql);
      await sql.commit(1, [
        { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
        { sql: "UPDATE users SET deleted_at = 150 WHERE id = 2" },
      ]);
      await rejected(() => completeAccountDeletionAsync(sql, USER, hash, 200), "bad_request");
      const [user] = await sql.read([{ sql: "SELECT deleted_at FROM users WHERE id = 1" }]);
      checkEqual(user, [{ deleted_at: null }]);
    },
  },
  {
    name: "a competing administrator departure prevents deleting the last administrator",
    async run(sql) {
      const hash = await seed(sql);
      await sql.commit(1, [{ sql: "UPDATE users SET role = 'administrator' WHERE id = 1" }]);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await completeAccountDeletionAsync(sql, { type: "user", userId: 2 }, null, 200);
          return rows;
        },
      };
      await rejected(() => completeAccountDeletionAsync(changing, USER, hash, 200), "bad_request");
      const [users] = await sql.read([
        { sql: "SELECT id FROM users WHERE deleted_at IS NULL AND role = 'administrator'" },
      ]);
      checkEqual([reads, users], [2, [{ id: 1 }]]);
    },
  },
  {
    name: "a changed password after lookup prevents stale verified deletion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET password_hash = 'changed-hash' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      await rejected(
        () =>
          deleteAccountAsync(
            changing,
            USER,
            { confirm: "delete", password: PASSWORD },
            OPTIONS,
            200,
          ),
        "forbidden",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "a password added during a conflict prevents passwordless deletion",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [{ sql: "UPDATE users SET password_hash = NULL WHERE id = 1" }]);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(2, [
              { sql: "UPDATE users SET password_hash = 'added-hash' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      await rejected(() => completeAccountDeletionAsync(changing, USER, null, 200), "forbidden");
      checkEqual(reads, 2);
    },
  },
  {
    name: "retries capture new pending work and volunteer activity and preserve competing reviews",
    async run(sql) {
      const hash = await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE suggestions SET status = 'approved' WHERE id = 1" },
              {
                sql: "INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, author_type, author_id, created_at) VALUES (5, 1, 'de', 'translation', '\"New\"', 'source-hash', 0, 'user', 1, 150)",
              },
              {
                sql: "INSERT INTO activity (id, type, actor_type, summary, detail, created_at) VALUES (5, 'review', 'system', 'Volunteer approved: Ada, as contributor', '{\"kind\":\"volunteer\",\"userId\":1}', 150)",
              },
            ]);
          return rows;
        },
      };
      await completeAccountDeletionAsync(changing, USER, hash, 200);
      const [suggestions, activity, history] = await sql.read([
        { sql: "SELECT id, status FROM suggestions WHERE id IN (1, 5) ORDER BY id" },
        { sql: "SELECT summary FROM activity WHERE id = 5" },
        { sql: "SELECT detail FROM history WHERE event = 'suggestion_withdrawn' ORDER BY id" },
      ]);
      checkEqual(
        [reads, suggestions, activity, history],
        [
          2,
          [
            { id: 1, status: "approved" },
            { id: 5, status: "withdrawn" },
          ],
          [{ summary: "Volunteer approved: Deleted user, as contributor" }],
          [{ detail: '{"suggestionId":2}' }, { detail: '{"suggestionId":5}' }],
        ],
      );
    },
  },
  {
    name: "failed deletion rolls back anonymization, withdrawn work, history, activity and credentials",
    async run(sql) {
      const hash = await seed(sql);
      const queries = [
        { sql: "SELECT * FROM users ORDER BY id" },
        { sql: "SELECT * FROM suggestions ORDER BY id" },
        { sql: "SELECT * FROM history ORDER BY id" },
        { sql: "SELECT * FROM activity ORDER BY id" },
        { sql: "SELECT * FROM identities ORDER BY id" },
        { sql: "SELECT * FROM sessions ORDER BY id_hash" },
        { sql: "SELECT * FROM email_tokens ORDER BY token_hash" },
        { sql: "SELECT * FROM invites ORDER BY id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ];
      const before = await sql.read(queries);
      const logs: unknown[] = [];
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_account_deletion_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await completeAccountDeletionAsync(failing, USER, hash, 200, {
          info: (message) => logs.push(message),
          debug() {},
          warn() {},
          error() {},
        });
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(await sql.read(queries), before);
      checkEqual(logs, []);
    },
  },
  {
    name: "validated deletion checks confirmation and access and logs only the deleted user ID after commit",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        secretKey: OPTIONS.secretKey,
        passwordIterations: 10,
        clock: () => 200,
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(
        () => api.deleteAccount(USER, { confirm: "yes" as "delete" }),
        "validation_failed",
      );
      await rejected(
        () => api.deleteAccount(ANONYMOUS, { confirm: "yes" as "delete" }),
        "unauthorized",
      );
      await rejected(() => api.deleteAccount(SYSTEM, { confirm: "delete" }), "bad_request");
      await rejected(
        () => api.deleteAccount({ type: "token", tokenId: 1 }, { confirm: "delete" }),
        "forbidden",
      );
      checkEqual(await api.deleteAccount(USER, { confirm: "delete", password: PASSWORD }), {
        ok: true,
      });
      checkEqual(logs, [["Account deleted", { userId: 1 }]]);
      await rejected(
        () => api.deleteAccount(USER, { confirm: "delete", password: PASSWORD }),
        "forbidden",
      );
    },
  },
];
