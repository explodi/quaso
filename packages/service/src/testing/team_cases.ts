// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import {
  checkInviteAsync,
  listInvitesAsync,
  listMembersAsync,
  listVolunteerRequestsAsync,
} from "../team.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [
    {
      sql: "UPDATE users SET role = 'administrator', password_hash = 'private-password-hash' WHERE id = 1",
    },
    { sql: "UPDATE users SET role = 'contributor', languages = '[\"de\"]' WHERE id = 2" },
    {
      sql: `INSERT INTO users (id, display_name, role, volunteer_status, volunteer_languages, volunteer_message, volunteer_requested_at, created_at, deleted_at) VALUES
      (3, 'Manager', 'manager', NULL, NULL, NULL, NULL, 100, NULL),
      (4, 'Pending', 'none', 'pending', '["de","fr"]', 'I can help', 10, 100, NULL),
      (5, 'Visitor', 'none', NULL, NULL, NULL, NULL, 100, NULL),
      (6, 'Deleted', 'administrator', NULL, NULL, NULL, NULL, 100, 101)`,
    },
    {
      sql: "INSERT INTO suggestions (string_id, language, kind, source_hash, base_revision, author_type, author_id, created_at) SELECT id, 'de', 'approval', source_hash, 3, 'user', 2, 100 FROM strings WHERE display_key = 'title'",
    },
    {
      sql: "INSERT INTO history (string_id, language, event, actor_type, actor_id, created_at) SELECT id, 'de', 'translation_saved', 'user', 2, 100 FROM strings WHERE display_key = 'play'",
    },
    {
      sql: "INSERT INTO history (string_id, language, event, actor_type, actor_id, created_at) SELECT id, NULL, 'source_changed', 'user', 2, 100 FROM strings WHERE display_key = 'play'",
    },
    {
      sql: `INSERT INTO invites (id, token_hash, role, languages, created_by, created_at, expires_at, used_at, used_by, revoked_at) VALUES
      (10, ?, 'contributor', '["de"]', 1, 100, 200, NULL, NULL, NULL),
      (11, ?, 'manager', NULL, 1, 100, 200, NULL, NULL, 101),
      (12, ?, 'contributor', NULL, 1, 100, 200, 101, 2, NULL),
      (13, ?, 'contributor', NULL, 1, 100, 100, NULL, NULL, NULL),
      (14, ?, 'manager', NULL, NULL, 100, 200, NULL, NULL, NULL)`,
      params: [
        sha256Hex("active"),
        sha256Hex("revoked"),
        sha256Hex("used"),
        sha256Hex("expired"),
        sha256Hex("system"),
      ],
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

export const TEAM_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "members are ordered by role and exclude visitors and deleted users",
    async run(sql) {
      await seed(sql);
      const result = await listMembersAsync(sql, ADMIN);
      checkEqual(
        result.members.map((member) => member.id),
        [1, 3, 2, 4],
      );
      checkEqual([result.members[2].contributions, result.members[2].languages], [2, ["de"]]);
      checkEqual(result.members[3].volunteerRequest, {
        status: "pending",
        languages: ["de", "fr"],
        message: "I can help",
        createdAt: 10,
      });
      check(!JSON.stringify(result).includes("private-password"));
      checkEqual(
        (await listVolunteerRequestsAsync(sql, ADMIN)).members.map((member) => member.id),
        [4],
      );
    },
  },
  {
    name: "only administrators and system callers can read team data",
    async run(sql) {
      await seed(sql);
      await rejected(() => listMembersAsync(sql, ANONYMOUS), "unauthorized");
      await rejected(() => listInvitesAsync(sql, { type: "user", userId: 3 }), "forbidden");
      await rejected(
        () => listVolunteerRequestsAsync(sql, { type: "user", userId: 2 }),
        "forbidden",
      );
      await rejected(() => listMembersAsync(sql, { type: "user", userId: 6 }), "forbidden");
      await rejected(() => listMembersAsync(sql, { type: "token", tokenId: 7 }), "forbidden");
      checkEqual((await listMembersAsync(sql, SYSTEM)).members.length, 4);
    },
  },
  {
    name: "invite lists include expired and used rows but exclude revoked rows and tokens",
    async run(sql) {
      await seed(sql);
      const result = await listInvitesAsync(sql, ADMIN);
      checkEqual(
        result.invites.map((invite) => invite.id),
        [14, 13, 12, 10],
      );
      checkEqual(result.invites[0].createdBy, { type: "system", id: null, name: "System" });
      checkEqual(result.invites[2].usedBy, {
        type: "user",
        id: 2,
        name: "Reviewer",
        avatarUrl: null,
      });
      checkEqual(result.invites[3], {
        id: 10,
        role: "contributor",
        languages: ["de"],
        createdAt: 100,
        expiresAt: 200,
        usedAt: null,
        usedBy: null,
        createdBy: { type: "user", id: 1, name: "Ada", avatarUrl: null },
      });
      check(!JSON.stringify(result).includes(sha256Hex("active")));
    },
  },
  {
    name: "public invite checks enforce use, revocation and strict expiry boundaries",
    async run(sql) {
      await seed(sql);
      checkEqual(await checkInviteAsync(sql, "active", 100), {
        valid: true,
        role: "contributor",
        languages: ["de"],
      });
      checkEqual(await checkInviteAsync(sql, "system", 100), {
        valid: true,
        role: "manager",
        languages: null,
      });
      const invalid = { valid: false, role: null, languages: null };
      checkEqual(await checkInviteAsync(sql, "active", 200), invalid);
      checkEqual(await checkInviteAsync(sql, "revoked", 100), invalid);
      checkEqual(await checkInviteAsync(sql, "used", 100), invalid);
      checkEqual(await checkInviteAsync(sql, "expired", 100), invalid);
      checkEqual(await checkInviteAsync(sql, "unknown", 100), invalid);
    },
  },
  {
    name: "member data and access share a snapshot across administrator demotion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(3, [
            { sql: "UPDATE users SET role = 'none', display_name = 'Changed' WHERE id = 1" },
          ]);
          return rows;
        },
      };
      const result = await listMembersAsync(changing, ADMIN);
      checkEqual([reads, result.members[0].displayName, result.members.length], [1, "Ada", 4]);
      await rejected(() => listMembersAsync(sql, ADMIN), "forbidden");
      checkEqual((await listMembersAsync(sql, SYSTEM)).members.length, 3);
    },
  },
  {
    name: "empty databases return empty team lists and invalid invite checks",
    async run(sql) {
      checkEqual(await listMembersAsync(sql, SYSTEM), { members: [] });
      checkEqual(await listVolunteerRequestsAsync(sql, SYSTEM), { members: [] });
      checkEqual(await listInvitesAsync(sql, SYSTEM), { invites: [] });
      checkEqual(await checkInviteAsync(sql, "unknown", 100), {
        valid: false,
        role: null,
        languages: null,
      });
    },
  },
];
