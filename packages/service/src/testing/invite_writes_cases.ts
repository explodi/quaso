// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import {
  checkInviteAsync,
  createInviteAsync,
  listInvitesAsync,
  revokeInviteAsync,
} from "../team.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };
const REQUEST = { role: "manager" as const, languages: ["DE", "de", "FR"] };
const BASE = "https://example.com///";
const DAY = 24 * 60 * 60 * 1000;

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager' WHERE id = 2" },
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

export const INVITE_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "creation returns the secret once and stores only its hash with canonical grants",
    async run(sql) {
      await seed(sql);
      const invite = await createInviteAsync(sql, ADMIN, REQUEST, BASE, 100);
      const token = new URL(invite.url!).searchParams.get("invite")!;
      checkEqual(invite, {
        id: 1,
        role: "manager",
        languages: ["de", "fr"],
        createdAt: 100,
        expiresAt: 100 + 7 * DAY,
        usedAt: null,
        usedBy: null,
        createdBy: { type: "user", id: 1, name: "Ada", avatarUrl: null },
        url: `https://example.com/signup?invite=${token}`,
      });
      const [stored] = await sql.read([{ sql: "SELECT token_hash FROM invites WHERE id = 1" }]);
      checkEqual(stored[0].token_hash, sha256Hex(token));
      check(!JSON.stringify(stored).includes(token));
      const listed = (await listInvitesAsync(sql, ADMIN)).invites[0];
      const { url: _url, ...metadata } = invite;
      checkEqual(listed, metadata);
      checkEqual(await checkInviteAsync(sql, token, 101), {
        valid: true,
        role: "manager",
        languages: ["de", "fr"],
      });
      checkEqual(await checkInviteAsync(sql, token, invite.expiresAt), {
        valid: false,
        role: null,
        languages: null,
      });
    },
  },
  {
    name: "system invites default to seven days and unrestricted languages",
    async run(sql) {
      await seed(sql);
      const invite = await createInviteAsync(sql, SYSTEM, { role: "contributor" }, BASE, 100);
      checkEqual(
        [invite.languages, invite.expiresAt, invite.createdBy],
        [null, 100 + 7 * DAY, { type: "system", id: null, name: "System" }],
      );
    },
  },
  {
    name: "revocation hides the invite and repeated revocation preserves its timestamp and revision",
    async run(sql) {
      await seed(sql);
      const invite = await createInviteAsync(sql, ADMIN, REQUEST, BASE, 100);
      const token = new URL(invite.url!).searchParams.get("invite")!;
      checkEqual(await revokeInviteAsync(sql, ADMIN, invite.id, 200), { ok: true });
      const noWrites: Sql = {
        ...sql,
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(await revokeInviteAsync(noWrites, ADMIN, invite.id, 300), { ok: true });
      checkEqual((await listInvitesAsync(sql, ADMIN)).invites, []);
      checkEqual(await checkInviteAsync(sql, token, 201), {
        valid: false,
        role: null,
        languages: null,
      });
      const [stored, revision] = await sql.read([
        { sql: "SELECT revoked_at FROM invites WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([stored, revision[0].value], [[{ revoked_at: 200 }], "5"]);
    },
  },
  {
    name: "access, unknown project languages and missing invite errors retain precedence",
    async run(sql) {
      await seed(sql);
      await rejected(() => createInviteAsync(sql, ANONYMOUS, REQUEST, BASE, 100), "unauthorized");
      await rejected(() => createInviteAsync(sql, MANAGER, REQUEST, BASE, 100), "forbidden");
      await rejected(() => revokeInviteAsync(sql, MANAGER, 999, 100), "forbidden");
      await rejected(
        () => revokeInviteAsync(sql, { type: "token", tokenId: 7 }, 999, 100),
        "forbidden",
      );
      await rejected(() => revokeInviteAsync(sql, ADMIN, 999, 100), "not_found");
      await rejected(
        () => createInviteAsync(sql, ADMIN, { ...REQUEST, languages: ["it"] }, BASE, 100),
        "bad_request",
      );
    },
  },
  {
    name: "overlapping creations reallocate IDs while keeping one token hash across retries",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const hashes: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await createInviteAsync(sql, SYSTEM, { role: "contributor" }, BASE, 150);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(statements[0].params![1]);
          return sql.commit(revision, statements);
        },
      };
      const invite = await createInviteAsync(changing, ADMIN, REQUEST, BASE, 100);
      checkEqual([reads, invite.id, hashes.length], [2, 2, 2]);
      const token = new URL(invite.url!).searchParams.get("invite")!;
      checkEqual(hashes, [sha256Hex(token), sha256Hex(token)]);
      checkEqual(
        (await listInvitesAsync(sql, ADMIN)).invites.map((entry) => entry.id),
        [2, 1],
      );
    },
  },
  {
    name: "a removed project language prevents a stale grant",
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
      await rejected(() => createInviteAsync(changing, ADMIN, REQUEST, BASE, 100), "bad_request");
      checkEqual([reads, (await listInvitesAsync(sql, ADMIN)).invites], [2, []]);
    },
  },
  {
    name: "creation rechecks administrator rights after demotion",
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
      await rejected(() => createInviteAsync(changing, ADMIN, REQUEST, BASE, 100), "forbidden");
      const [invites] = await sql.read([{ sql: "SELECT id FROM invites" }]);
      checkEqual([reads, invites], [2, []]);
    },
  },
  {
    name: "revocation rechecks administrator rights after demotion",
    async run(sql) {
      await seed(sql);
      await createInviteAsync(sql, ADMIN, REQUEST, BASE, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(4, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => revokeInviteAsync(changing, ADMIN, 1, 200), "forbidden");
      const [invites] = await sql.read([{ sql: "SELECT revoked_at FROM invites WHERE id = 1" }]);
      checkEqual([reads, invites], [2, [{ revoked_at: null }]]);
    },
  },
  {
    name: "competing revocations preserve the first timestamp and skip a second commit",
    async run(sql) {
      await seed(sql);
      await createInviteAsync(sql, ADMIN, REQUEST, BASE, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await revokeInviteAsync(sql, SYSTEM, 1, 150);
          return rows;
        },
      };
      await revokeInviteAsync(changing, ADMIN, 1, 200);
      const [invites, revision] = await sql.read([
        { sql: "SELECT revoked_at FROM invites WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([reads, invites, revision[0].value], [2, [{ revoked_at: 150 }], "5"]);
    },
  },
  {
    name: "failed creation leaves no invite or raised revision",
    async run(sql) {
      await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_invite_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await createInviteAsync(failing, ADMIN, REQUEST, BASE, 100);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [invites, revision] = await sql.read([
        { sql: "SELECT id FROM invites" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([invites, revision[0].value], [[], "3"]);
    },
  },
  {
    name: "validated invite entry points preserve access and input errors",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql, clock: () => 100 });
      await rejected(
        () => api.createInvite(ANONYMOUS, { role: "manager", baseUrl: "" }),
        "unauthorized",
      );
      await rejected(
        () => api.createInvite(ADMIN, { role: "manager", baseUrl: "" }),
        "validation_failed",
      );
      await rejected(() => api.revokeInvite(MANAGER, { id: 0 }), "forbidden");
      const invite = await api.createInvite(ADMIN, { ...REQUEST, baseUrl: BASE });
      checkEqual(await api.revokeInvite(ADMIN, { id: invite.id }), { ok: true });
    },
  },
];
