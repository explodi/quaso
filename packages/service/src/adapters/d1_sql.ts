// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { ServiceError } from "../errors.ts";
import { SQL_MAX_PARAMS, type Sql, type SqlRow, type SqlValue, type Statement } from "../ports.ts";
import { RevisionConflict, readStatement } from "../write.ts";

export type D1Statement = { sql: string; params: (string | number | null | number[])[] };

/** SQL in, rows out over the container's private outbound binding handler. */
export function createD1Sql(options: { fetch?: Fetch } = {}): Sql {
  const doFetch = options.fetch ?? fetch;
  async function batch(statements: Statement[]): Promise<SqlRow[][]> {
    if (statements.length === 0) return [];
    const input: D1Statement[] = statements.map((statement) => {
      const params = statement.params ?? [];
      if (params.length > SQL_MAX_PARAMS) throw new RangeError("Too many SQL parameters");
      return { sql: statement.sql, params: params.map(parameter) };
    });
    let response: Response;
    try {
      response = await doFetch("http://d1.quaso.internal/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statements: input }),
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw unavailable();
    }
    if (response.status === 409) {
      await response.body?.cancel();
      throw new RevisionConflict();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows) || rows.length !== statements.length) throw unavailable();
    return rows.map((result: Record<string, unknown>[]) => {
      if (!Array.isArray(result)) throw unavailable();
      return result.map((row) => {
        const isRow = row !== null && typeof row === "object" && !Array.isArray(row);
        if (!isRow) throw unavailable();
        const normalized: SqlRow = {};
        for (const [name, value] of Object.entries(row)) {
          normalized[name] = Array.isArray(value) ? new Uint8Array(value) : (value as SqlValue);
        }
        return normalized;
      });
    });
  }
  return {
    read: (statements) =>
      batch(statements.map((statement) => ({ ...statement, sql: readStatement(statement.sql) }))),
    async commit(revision, statements) {
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new RangeError("Invalid project revision");
      await batch([
        { sql: "UPDATE revision_guard SET expected_revision = ? WHERE id = 1", params: [revision] },
        ...statements,
      ]);
      return revision + 1;
    },
    async migrate(statements) {
      await batch(statements);
    },
  };
}

function parameter(value: SqlValue): D1Statement["params"][number] {
  if (value instanceof Uint8Array) return Array.from(value);
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError("D1 requires exact numeric parameters");
    return number;
  }
  if (typeof value === "number") {
    const isFinite = Number.isFinite(value);
    const isExact = !Number.isInteger(value) || Number.isSafeInteger(value);
    if (!isFinite || !isExact) throw new RangeError("D1 requires finite, exact numeric parameters");
  }
  return value;
}

function unavailable() {
  return new ServiceError("unavailable", "The database is unavailable. Try again shortly.");
}
