// SPDX-License-Identifier: MIT
/** Credential values stay inside storage; administration returns only a safe suffix. */
import { type ManagedSecretName, type SecretStatus, type SecretsResult } from "@quaso/core";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision } from "./db.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Sql, SqlRow, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";

const NAMES: ManagedSecretName[] = ["gemini_api_key", "email_api_key"];
const REQUIREMENT_PREFIX = "configured_secret:";
export const SECRET_REQUIREMENTS: Statement = {
  sql: "SELECT key FROM meta WHERE key IN ('configured_secret:gemini_api_key', 'configured_secret:email_api_key')",
};

/** Backup metadata retains names so the restored panel can ask for omitted credentials. */
export function configuredSecrets(rows: SqlRow[]): ManagedSecretName[] {
  return NAMES.filter((name) => rows.some((row) => row.key === `${REQUIREMENT_PREFIX}${name}`));
}
const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};
type Row = SqlRow & { name: string; value: string; updated_at: number };

function describe(name: ManagedSecretName, row: Row | undefined): SecretStatus {
  return {
    name,
    set: row !== undefined,
    // Short values must not be returned in their entirety.
    ending: row && row.value.length > 4 ? row.value.slice(-4) : null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function listSecrets(ctx: Context): SecretsResult {
  const rows = ctx.sql.query<Row>("SELECT name, value, updated_at FROM secrets");
  return {
    missingSecrets: configuredSecrets(ctx.sql.query(SECRET_REQUIREMENTS.sql)).filter(
      (name) => !rows.some((row) => row.name === name),
    ),
    secrets: NAMES.map((name) =>
      describe(
        name,
        rows.find((row) => row.name === name),
      ),
    ),
  };
}

export async function listSecretsAsync(sql: Sql, actor: Actor): Promise<SecretsResult> {
  const [rows, requirements, ...permissionRows] = await sql.read([
    { sql: "SELECT name, value, updated_at FROM secrets" },
    SECRET_REQUIREMENTS,
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("settings");
  return {
    missingSecrets: configuredSecrets(requirements).filter(
      (name) => !rows.some((row) => row.name === name),
    ),
    secrets: NAMES.map((name) =>
      describe(
        name,
        (rows as Row[]).find((row) => row.name === name),
      ),
    ),
  };
}

function change(
  name: ManagedSecretName,
  value: string | null,
  current: Row | undefined,
  actor: Actor,
  now: number,
  required: boolean,
) {
  // A distinct write must invalidate a previous provider test, even within one clock tick.
  const updatedAt = Math.max(now, (current?.updated_at ?? 0) + 1);
  const result = describe(
    name,
    value === null ? undefined : { name, value, updated_at: updatedAt },
  );
  if ((current?.value ?? null) === value && required === (value !== null))
    return { statements: [], result: describe(name, current) };
  const statement: Statement =
    value === null
      ? { sql: "DELETE FROM secrets WHERE name = ?", params: [name] }
      : {
          sql: "INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          params: [name, value, updatedAt],
        };
  const action = value === null ? "removed" : current ? "replaced" : "set";
  const requirement: Statement =
    value === null
      ? { sql: "DELETE FROM meta WHERE key = ?", params: [`${REQUIREMENT_PREFIX}${name}`] }
      : {
          sql: "INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO NOTHING",
          params: [`${REQUIREMENT_PREFIX}${name}`],
        };
  const activity: Statement = {
    sql: "INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at) VALUES ('secret', ?, ?, ?, ?, ?, ?)",
    params: [
      actor.type,
      actor.type === "user" ? actor.userId : null,
      actor.type === "system" ? "System" : null,
      `Secret ${name} ${action}`,
      JSON.stringify({ name, action }),
      now,
    ],
  };
  return { statements: [statement, requirement, activity], result };
}

export function changeSecret(
  ctx: Context,
  actor: Actor,
  name: ManagedSecretName,
  value: string | null,
): SecretStatus {
  const current = ctx.sql.query<Row>(
    "SELECT name, value, updated_at FROM secrets WHERE name = ?",
    name,
  )[0];
  const required = configuredSecrets(ctx.sql.query(SECRET_REQUIREMENTS.sql)).includes(name);
  const plan = change(name, value, current, actor, ctx.clock(), required);
  for (const statement of plan.statements) ctx.sql.run(statement.sql, ...(statement.params ?? []));
  if (plan.statements.length > 0) bumpRevision(ctx.sql);
  return plan.result;
}

export async function changeSecretAsync(
  sql: Sql,
  actor: Actor,
  name: ManagedSecretName,
  value: string | null,
  now: number,
): Promise<SecretStatus> {
  return withRetries(
    sql,
    async () => {
      const [revision, rows, requirements, ...permissionRows] = await sql.read([
        REVISION,
        { sql: "SELECT name, value, updated_at FROM secrets WHERE name = ?", params: [name] },
        SECRET_REQUIREMENTS,
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          row: rows[0] as Row | undefined,
          required: configuredSecrets(requirements).includes(name),
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ row, required, permissions }) => {
      permissions.require("settings");
      return change(name, value, row, actor, now, required);
    },
  );
}
