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

/*
 * Writes through the same `Sql` take turns reading and committing instead of racing for the
 * revision: racing, a translator's saves sent together, their LLM suggestions and a running job
 * made each other retry until some ran out of tries. The service sends every request's writes
 * through one `Sql`; the revision guard still catches writers that don't share it.
 */
const lastTurn = new WeakMap<Sql, Promise<unknown>>();

/** A write must not start another through the same `Sql`: it would wait for itself. */
function inTurn<T>(sql: Sql, write: () => Promise<T>): Promise<T> {
  const turn = (lastTurn.get(sql) ?? Promise.resolve()).then(write);
  lastTurn.set(
    sql,
    turn.catch(() => {}),
  );
  return turn;
}

export async function withRetries<State, Result>(
  sql: Sql,
  read: () => Promise<{ revision: number; state: State }>,
  decide: (state: State) => { statements: Statement[]; result: Result },
): Promise<Result> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const outcome = await inTurn(sql, async () => {
      const { revision, state } = await read();
      const { statements, result } = decide(state);
      if (statements.length === 0) return { committed: true, result };
      try {
        await sql.commit(revision, statements);
        return { committed: true, result };
      } catch (error) {
        if (!(error instanceof RevisionConflict)) throw error;
        return { committed: false, result };
      }
    });
    if (outcome.committed) return outcome.result;
  }
  throw new ServiceError("unavailable", "The project is busy. Try again shortly.");
}

/** A subquery cannot contain a write or change a connection's read-only setting. */
export function readStatement(sql: string): string {
  return `SELECT * FROM (${sql.trim().replace(/;$/, "")})`;
}
