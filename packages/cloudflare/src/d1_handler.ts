// SPDX-License-Identifier: MIT
import { type Logger, SQL_MAX_PARAMS } from "@quaso/service";
import { REVISION_CONFLICT_MESSAGE } from "../../service/src/write.ts";
import type { D1Statement } from "../../service/src/adapters/d1_sql.ts";
import { createLogger } from "./log.ts";

/**
 * A batch worth a line in the logs: the database runs one batch at a time, so a slow one
 * delays every request behind it, and a large answer is parsed twice on its way to the server.
 */
export const SLOW_BATCH_MS = 1000;
export const LARGE_BATCH_BYTES = 1024 * 1024;

/** As much of a statement as a log line shows; parameters are never logged. */
const LOGGED_SQL_LENGTH = 300;

/** Only registered as an outbound handler; the public Worker never routes here. */
export async function handleD1(
  request: Request,
  database: D1Database,
  log: Logger = createLogger("data"),
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/batch")
    return new Response(null, { status: 404 });
  let input: { statements: D1Statement[] };
  try {
    input = await request.json();
    if (!Array.isArray(input?.statements)) throw new Error("Invalid batch");
    for (const statement of input.statements) {
      if (typeof statement?.sql !== "string" || !Array.isArray(statement.params))
        throw new Error("Invalid statement");
      if (statement.params.length > SQL_MAX_PARAMS) throw new Error("Too many parameters");
    }
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (input.statements.length === 0) return Response.json([]);
  const started = Date.now();
  try {
    const results = await database.batch(
      input.statements.map((statement) =>
        database.prepare(statement.sql).bind(...statement.params),
      ),
    );
    const body = JSON.stringify(results.map((result) => result.results));
    const ms = Date.now() - started;
    if (ms >= SLOW_BATCH_MS || body.length >= LARGE_BATCH_BYTES) {
      const rowsRead = results.map((result) => result.meta.rows_read);
      const heaviest = rowsRead.indexOf(Math.max(...rowsRead));
      log.warn("A database batch was slow or large", {
        ms,
        bytes: body.length,
        statements: input.statements.length,
        rowsRead: rowsRead.reduce((sum, rows) => sum + rows, 0),
        sql: loggedSql(input.statements[heaviest]),
      });
    }
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    if (error instanceof Error && error.message.includes(REVISION_CONFLICT_MESSAGE)) {
      return Response.json({ error: "revision_conflict" }, { status: 409 });
    }
    log.error("A database batch failed", {
      error,
      ms: Date.now() - started,
      statements: input.statements.length,
      sql: loggedSql(input.statements[0]),
    });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}

function loggedSql(statement: D1Statement): string {
  return statement.sql.replace(/\s+/g, " ").trim().slice(0, LOGGED_SQL_LENGTH);
}
