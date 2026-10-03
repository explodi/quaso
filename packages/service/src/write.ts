// SPDX-License-Identifier: MIT
import { ServiceError } from "./errors.ts";
import type { Sql, Statement } from "./ports.ts";

export class RevisionConflict extends Error {
  constructor() {
    super("The project changed before the write could commit.");
    this.name = "RevisionConflict";
  }
}

export const REVISION_CONFLICT_MESSAGE = "quaso_revision_conflict";

/** The guard is updated first, so a stale batch aborts before any project changes. */
export const GUARD_STATEMENTS: Statement[] = [
  {
    sql: "CREATE TABLE IF NOT EXISTS revision_guard (id INTEGER PRIMARY KEY CHECK (id = 1), expected_revision INTEGER NOT NULL) STRICT",
  },
  { sql: "INSERT INTO revision_guard VALUES (1, 0) ON CONFLICT (id) DO NOTHING" },
  {
    sql: `CREATE TRIGGER IF NOT EXISTS check_revision BEFORE UPDATE ON revision_guard
    WHEN NEW.expected_revision != COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0)
    BEGIN SELECT RAISE(ABORT, 'quaso_revision_conflict'); END`,
  },
  {
    sql: `CREATE TRIGGER IF NOT EXISTS raise_revision AFTER UPDATE ON revision_guard
    BEGIN INSERT INTO meta (key, value) VALUES ('revision', CAST(NEW.expected_revision + 1 AS TEXT))
    ON CONFLICT (key) DO UPDATE SET value = excluded.value; END`,
  },
];

export async function withRetries<State, Result>(
  sql: Sql,
  read: () => Promise<{ revision: number; state: State }>,
  decide: (state: State) => { statements: Statement[]; result: Result },
): Promise<Result> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { revision, state } = await read();
    const { statements, result } = decide(state);
    if (statements.length === 0) return result;
    try {
      await sql.commit(revision, statements);
      return result;
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error;
    }
  }
  throw new ServiceError("unavailable", "The project is busy. Try again shortly.");
}

/** A subquery cannot contain a write or change a connection's read-only setting. */
export function readStatement(sql: string): string {
  return `SELECT * FROM (${sql.trim().replace(/;$/, "")})`;
}
