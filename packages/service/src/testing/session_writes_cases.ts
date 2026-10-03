// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import {
  createSessionAsync,
  deleteSessionAsync,
  planSessionCreation,
  resolveSessionAsync,
  SESSION_TOUCH_INTERVAL,
  SESSION_TTL,
} from "../sessions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, created_at) VALUES (1, 'Ada', 100), (2, 'Other', 100)",
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

export const SESSION_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "account deletion during a touch invalidates and removes the session on retry",
    async run(sql) {
      await seed(sql);
      const created = await createSessionAsync(sql, 1, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(2, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" }]);
          return rows;
        },
      };
      checkEqual(
        await resolveSessionAsync(
          changing,
          SYSTEM,
          created.sessionId,
          100 + SESSION_TOUCH_INTERVAL,
        ),
        null,
      );
      const [sessions] = await sql.read([{ sql: "SELECT id_hash FROM sessions" }]);
      checkEqual([reads, sessions], [2, []]);
    },
  },
  {
    name: "creation stores only the hash, bounds user agents and deletes expired sessions",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [
        {
          sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('old', 2, 0, 100, 0), ('active', 2, 0, 1000, 0)",
        },
      ]);
      const created = await createSessionAsync(sql, 1, 100, "x".repeat(400));
      checkEqual(created.expiresAt, 100 + SESSION_TTL);
      const [stored, user, retained] = await sql.read([
        {
          sql: "SELECT id_hash, user_id, created_at, expires_at, last_seen_at, user_agent FROM sessions WHERE user_id = 1",
        },
        { sql: "SELECT last_seen_at FROM users WHERE id = 1" },
        { sql: "SELECT id_hash FROM sessions WHERE user_id = 2" },
      ]);
      checkEqual(stored, [
        {
          id_hash: sha256Hex(created.sessionId),
          user_id: 1,
          created_at: 100,
          expires_at: created.expiresAt,
          last_seen_at: 100,
          user_agent: "x".repeat(300),
        },
      ]);
      check(!JSON.stringify(stored).includes(created.sessionId));
      checkEqual([user, retained], [[{ last_seen_at: 100 }], [{ id_hash: "active" }]]);
    },
  },
  {
    name: "session planning composes with an account insert in one commit",
    async run(sql) {
      await seed(sql);
      const plan = planSessionCreation(3, "new-account-session", 200);
      await sql.commit(1, [
        { sql: "INSERT INTO users (id, display_name, created_at) VALUES (3, 'New', 200)" },
        ...plan.statements,
      ]);
      checkEqual(await resolveSessionAsync(sql, SYSTEM, plan.result.sessionId, 201), {
        userId: 3,
        expiresAt: 200 + SESSION_TTL,
      });
    },
  },
  {
    name: "resolution throttles touches and extends expiry at the interval boundary",
    async run(sql) {
      await seed(sql);
      const created = await createSessionAsync(sql, 1, 100);
      const noWrites: Sql = {
        ...sql,
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(
        await resolveSessionAsync(
          noWrites,
          SYSTEM,
          created.sessionId,
          100 + SESSION_TOUCH_INTERVAL - 1,
        ),
        { userId: 1, expiresAt: created.expiresAt },
      );
      const now = 100 + SESSION_TOUCH_INTERVAL;
      checkEqual(await resolveSessionAsync(sql, SYSTEM, created.sessionId, now), {
        userId: 1,
        expiresAt: now + SESSION_TTL,
      });
      const [session, user] = await sql.read([
        { sql: "SELECT last_seen_at FROM sessions WHERE user_id = 1" },
        { sql: "SELECT last_seen_at FROM users WHERE id = 1" },
      ]);
      checkEqual([session, user], [[{ last_seen_at: now }], [{ last_seen_at: now }]]);
    },
  },
  {
    name: "unknown, expired and deleted-account sessions cannot resolve",
    async run(sql) {
      await seed(sql);
      checkEqual(await resolveSessionAsync(sql, SYSTEM, "unknown", 100), null);
      const expired = await createSessionAsync(sql, 1, 100);
      checkEqual(
        await resolveSessionAsync(sql, SYSTEM, expired.sessionId, expired.expiresAt),
        null,
      );
      const deleted = await createSessionAsync(sql, 1, 200);
      await sql.commit(4, [{ sql: "UPDATE users SET deleted_at = 300 WHERE id = 1" }]);
      checkEqual(await resolveSessionAsync(sql, SYSTEM, deleted.sessionId, 300), null);
      await rejected(() => createSessionAsync(sql, 1, 400), "not_found");
      await rejected(() => createSessionAsync(sql, 999, 400), "not_found");
      const [sessions] = await sql.read([{ sql: "SELECT id_hash FROM sessions" }]);
      checkEqual(sessions, []);
    },
  },
  {
    name: "only the system resolves sessions and sign-out remains a token capability",
    async run(sql) {
      await seed(sql);
      const inaccessible: Sql = {
        ...sql,
        async read() {
          throw new Error("Unexpected read");
        },
      };
      await rejected(
        () => resolveSessionAsync(inaccessible, ANONYMOUS, "secret", 100),
        "forbidden",
      );
      await rejected(
        () => resolveSessionAsync(inaccessible, { type: "user", userId: 1 }, "secret", 100),
        "forbidden",
      );
      const created = await createSessionAsync(sql, 1, 100);
      const api = asyncWriteMethods({ sql, clock: () => 200 });
      checkEqual(await api.signOut(ANONYMOUS, { sessionId: created.sessionId }), { ok: true });
      checkEqual(await api.resolveSession(SYSTEM, { sessionId: created.sessionId }), null);
      const noWrites: Sql = {
        ...sql,
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(await deleteSessionAsync(noWrites, created.sessionId), { ok: true });
      await rejected(() => api.signOut(ANONYMOUS, { sessionId: "" }), "validation_failed");
    },
  },
  {
    name: "creation retains one secret across revision retries",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const hashes: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 1" },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(statements[1].params![0]);
          return sql.commit(revision, statements);
        },
      };
      const created = await createSessionAsync(changing, 1, 100);
      checkEqual(
        [reads, hashes],
        [2, [sha256Hex(created.sessionId), sha256Hex(created.sessionId)]],
      );
    },
  },
  {
    name: "creation retries refuse an account deleted after the snapshot",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 150 WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => createSessionAsync(changing, 1, 100), "not_found");
      const [sessions] = await sql.read([{ sql: "SELECT id_hash FROM sessions" }]);
      checkEqual([reads, sessions], [2, []]);
    },
  },
  {
    name: "a competing sign-out prevents a stale touch from restoring the session",
    async run(sql) {
      await seed(sql);
      const created = await createSessionAsync(sql, 1, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await deleteSessionAsync(sql, created.sessionId);
          return rows;
        },
      };
      checkEqual(
        await resolveSessionAsync(
          changing,
          SYSTEM,
          created.sessionId,
          100 + SESSION_TOUCH_INTERVAL,
        ),
        null,
      );
      const [users] = await sql.read([{ sql: "SELECT last_seen_at FROM users WHERE id = 1" }]);
      checkEqual([reads, users], [2, [{ last_seen_at: 100 }]]);
    },
  },
  {
    name: "competing touches preserve the newest expiry without another write",
    async run(sql) {
      await seed(sql);
      const created = await createSessionAsync(sql, 1, 100);
      const newer = 100 + SESSION_TOUCH_INTERVAL + 10;
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await resolveSessionAsync(sql, SYSTEM, created.sessionId, newer);
          return rows;
        },
      };
      checkEqual(await resolveSessionAsync(changing, SYSTEM, created.sessionId, newer - 10), {
        userId: 1,
        expiresAt: newer + SESSION_TTL,
      });
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual([reads, revision[0].value], [2, "3"]);
    },
  },
  {
    name: "competing sign-outs skip the second deletion commit",
    async run(sql) {
      await seed(sql);
      const created = await createSessionAsync(sql, 1, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await deleteSessionAsync(sql, created.sessionId);
          return rows;
        },
      };
      checkEqual(await deleteSessionAsync(changing, created.sessionId), { ok: true });
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual([reads, revision[0].value], [2, "3"]);
    },
  },
  {
    name: "failed creation rolls back expiry cleanup, insertion and user last-use together",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [
        {
          sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('old', 2, 0, 100, 0)",
        },
      ]);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_session_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await createSessionAsync(failing, 1, 100);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [sessions, user, revision] = await sql.read([
        { sql: "SELECT id_hash FROM sessions" },
        { sql: "SELECT last_seen_at FROM users WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [sessions, user, revision[0].value],
        [[{ id_hash: "old" }], [{ last_seen_at: null }], "2"],
      );
    },
  },
];
