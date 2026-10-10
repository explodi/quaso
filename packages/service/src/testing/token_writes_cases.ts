// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import {
  authenticateTokenAsync,
  createApiTokenAsync,
  LAST_USED_INTERVAL,
  listApiTokensAsync,
  revokeApiTokenAsync,
} from "../tokens.ts";
import { check, checkEqual } from "./assert.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { silentLogger } from "../ports.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const REQUEST = { name: "CI", scope: "upload" } as const;

async function seed(sql: Sql): Promise<void> {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Ada', 'administrator', 100), (2, 'Manager', 'manager', 100)",
    },
  ]);
}

async function revision(sql: Sql): Promise<number> {
  const [rows] = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS n",
    },
  ]);
  return Number(rows[0].n);
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

export const TOKEN_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "creation stores only a hash and returns one random secret with administrative metadata",
    async run(sql) {
      const created = await createApiTokenAsync(sql, SYSTEM, REQUEST, 100);
      check(/^qso_[A-Za-z0-9_-]{43}$/.test(created.secret));
      checkEqual(
        [
          created.id,
          created.name,
          created.scope,
          created.prefix,
          created.createdBy,
          created.createdAt,
          created.lastUsedAt,
          created.revokedAt,
        ],
        [1, "CI", "upload", created.secret.slice(0, 8), null, 100, null, null],
      );
      const [rows] = await sql.read([{ sql: "SELECT * FROM api_tokens" }]);
      checkEqual(rows[0].secret_hash, sha256Hex(created.secret));
      checkEqual(JSON.stringify(rows).includes(created.secret), false);
      const second = await createApiTokenAsync(sql, SYSTEM, REQUEST, 200);
      check(created.secret !== second.secret);
      checkEqual([second.id, await revision(sql)], [2, 2]);
    },
  },
  {
    name: "revocation preserves creator attribution and repeated revocation is a no-op",
    async run(sql) {
      await seed(sql);
      const created = await createApiTokenAsync(sql, ADMIN, REQUEST, 100);
      checkEqual(created.createdBy, { type: "user", id: 1, name: "Ada", avatarUrl: null });
      await revokeApiTokenAsync(sql, ADMIN, created.id, 200);
      await revokeApiTokenAsync(sql, ADMIN, created.id, 300);
      const listed = (await listApiTokensAsync(sql, ADMIN)).tokens[0];
      checkEqual(
        [listed.revokedAt, listed.createdBy, await revision(sql)],
        [200, created.createdBy, 3],
      );
      checkEqual("secret" in listed, false);
      checkEqual(await authenticateTokenAsync(sql, SYSTEM, created.secret, 400), null);
      await rejected(() => revokeApiTokenAsync(sql, ADMIN, 999, 400), "not_found");
      checkEqual(await revision(sql), 3);
    },
  },
  {
    name: "management and authentication permissions are enforced before writing",
    async run(sql) {
      await seed(sql);
      await rejected(() => createApiTokenAsync(sql, ANONYMOUS, REQUEST, 100), "unauthorized");
      await rejected(
        () => createApiTokenAsync(sql, { type: "token", tokenId: 1 }, REQUEST, 100),
        "forbidden",
      );
      await rejected(
        () => revokeApiTokenAsync(sql, { type: "token", tokenId: 1 }, 999, 100),
        "forbidden",
      );
      await rejected(() => authenticateTokenAsync(sql, ADMIN, "nope", 100), "forbidden");
      const noReads: Sql = {
        ...sql,
        async read() {
          throw new Error("Invalid prefixes need no read");
        },
      };
      checkEqual(await authenticateTokenAsync(noReads, SYSTEM, "nope", 100), null);
      checkEqual(await revision(sql), 1);
    },
  },
  {
    name: "authentication records last use at most once per minute",
    async run(sql) {
      const created = await createApiTokenAsync(sql, SYSTEM, REQUEST, 100);
      checkEqual(await authenticateTokenAsync(sql, SYSTEM, created.secret, 100), {
        tokenId: 1,
        scope: "upload",
        name: "CI",
      });
      checkEqual(await revision(sql), 2);
      await authenticateTokenAsync(sql, SYSTEM, created.secret, 100 + LAST_USED_INTERVAL - 1);
      checkEqual(await revision(sql), 2);
      await authenticateTokenAsync(sql, SYSTEM, created.secret, 100 + LAST_USED_INTERVAL);
      checkEqual(await revision(sql), 3);
      checkEqual(
        (await listApiTokensAsync(sql, SYSTEM)).tokens[0].lastUsedAt,
        100 + LAST_USED_INTERVAL,
      );
      checkEqual(await authenticateTokenAsync(sql, SYSTEM, "qso_unknown", 200), null);
      checkEqual(await revision(sql), 3);
    },
  },
  {
    name: "overlapping creations retry ID allocation without duplicating either key",
    async run(sql) {
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await createApiTokenAsync(sql, SYSTEM, { name: "Other", scope: "read" }, 200);
          return rows;
        },
      };
      const created = await createApiTokenAsync(changing, SYSTEM, REQUEST, 100);
      checkEqual([reads, created.id, await revision(sql)], [2, 2, 2]);
      const [rows] = await sql.read([
        { sql: "SELECT id, name, secret_hash FROM api_tokens ORDER BY id" },
      ]);
      checkEqual(
        rows.map((row) => [row.id, row.name]),
        [
          [1, "Other"],
          [2, "CI"],
        ],
      );
      checkEqual(rows[1].secret_hash, sha256Hex(created.secret));
    },
  },
  {
    name: "a conflicting account deletion refuses creation on the fresh snapshot",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 100 WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => createApiTokenAsync(changing, ADMIN, REQUEST, 100), "forbidden");
      const [rows] = await sql.read([{ sql: "SELECT id FROM api_tokens" }]);
      checkEqual([reads, rows, await revision(sql)], [2, [], 2]);
    },
  },
  {
    name: "revocation retries after another committed edit and retains that edit",
    async run(sql) {
      const created = await createApiTokenAsync(sql, SYSTEM, REQUEST, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [{ sql: "UPDATE api_tokens SET name = 'Renamed' WHERE id = 1" }]);
          return rows;
        },
      };
      await revokeApiTokenAsync(changing, SYSTEM, created.id, 200);
      const token = (await listApiTokensAsync(sql, SYSTEM)).tokens[0];
      checkEqual([reads, token.name, token.revokedAt, await revision(sql)], [2, "Renamed", 200, 3]);
    },
  },
  {
    name: "revocation wins over a conflicting authentication touch",
    async run(sql) {
      const created = await createApiTokenAsync(sql, SYSTEM, REQUEST, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await revokeApiTokenAsync(sql, SYSTEM, created.id, 200);
          return rows;
        },
      };
      checkEqual(await authenticateTokenAsync(changing, SYSTEM, created.secret, 100), null);
      const token = (await listApiTokensAsync(sql, SYSTEM)).tokens[0];
      checkEqual(
        [reads, token.lastUsedAt, token.revokedAt, await revision(sql)],
        [2, null, 200, 2],
      );
    },
  },
  {
    name: "validated key methods retain errors and log only nonsecret metadata",
    async run(sql) {
      await seed(sql);
      const messages: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        clock: () => 100,
        logger: {
          ...silentLogger,
          info(message, fields) {
            messages.push([message, fields]);
          },
        },
      });
      await rejected(
        () => api.createApiToken(ANONYMOUS, { name: "CI", scope: "invalid" } as never),
        "unauthorized",
      );
      await rejected(
        () => api.createApiToken(ADMIN, { name: "CI", scope: "invalid" } as never),
        "validation_failed",
      );
      await rejected(() => api.revokeApiToken(ADMIN, { id: 0 }), "validation_failed");
      const created = await api.createApiToken(ADMIN, REQUEST);
      checkEqual(await api.authenticateToken(SYSTEM, { secret: created.secret }), {
        tokenId: created.id,
        name: "CI",
        scope: "upload",
      });
      checkEqual(await api.revokeApiToken(ADMIN, { id: created.id }), { ok: true });
      checkEqual(messages, [
        ["API key created", { id: created.id, scope: "upload" }],
        ["API key revoked", { id: created.id }],
      ]);
      checkEqual(JSON.stringify(messages).includes(created.secret), false);
    },
  },
  {
    name: "a competing authentication touch prevents another throttled write",
    async run(sql) {
      const created = await createApiTokenAsync(sql, SYSTEM, REQUEST, 100);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await authenticateTokenAsync(sql, SYSTEM, created.secret, 250);
          return rows;
        },
      };
      checkEqual(await authenticateTokenAsync(changing, SYSTEM, created.secret, 200), {
        tokenId: 1,
        scope: "upload",
        name: "CI",
      });
      checkEqual(
        [reads, (await listApiTokensAsync(sql, SYSTEM)).tokens[0].lastUsedAt, await revision(sql)],
        [2, 250, 2],
      );
    },
  },
];
