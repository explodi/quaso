// SPDX-License-Identifier: MIT
import { SQL_MAX_PARAMS } from "@quaso/service";
import { REVISION_CONFLICT_MESSAGE } from "../../service/src/write.ts";
import type { D1Statement } from "../../service/src/adapters/d1_sql.ts";

/** Only registered as an outbound handler; the public Worker never routes here. */
export async function handleD1(request: Request, database: D1Database): Promise<Response> {
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
  try {
    const results = await database.batch(
      input.statements.map((statement) =>
        database.prepare(statement.sql).bind(...statement.params),
      ),
    );
    return Response.json(results.map((result) => result.results));
  } catch (error) {
    if (error instanceof Error && error.message.includes(REVISION_CONFLICT_MESSAGE)) {
      return Response.json({ error: "revision_conflict" }, { status: 409 });
    }
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
