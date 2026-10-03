// SPDX-License-Identifier: MIT
/** Host credentials are instance-local, immutable, and excluded from portable backups. */
import type { Sql, Statement } from "./ports.ts";

export const INSTANCE_SECRETS: Statement = {
  sql: "SELECT name, value, updated_at FROM secrets WHERE name IN ('instance_key', 'instance_salt')",
};

export async function ensureInstanceSecrets(sql: Sql, now = Date.now()) {
  const secret = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  // These immutable host defaults do not change project revisions or interrupted restore state.
  await sql.migrate(
    ["instance_key", "instance_salt"].map((name) => ({
      sql: "INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING",
      params: [name, secret(), now],
    })),
  );
  const [rows] = await sql.read([INSTANCE_SECRETS]);
  const values = new Map(rows.map((row) => [String(row.name), String(row.value)]));
  const key = values.get("instance_key");
  const salt = values.get("instance_salt");
  if (!key || !salt || key.length < 32 || salt.length < 32)
    throw new Error("The stored instance credentials are missing or invalid.");
  return { key, salt };
}
