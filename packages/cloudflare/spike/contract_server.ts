// SPDX-License-Identifier: MIT
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { BATCH_SQL_CASES, initializeBatchSql } from "../../service/src/testing/batch_sql_cases.ts";

Deno.serve({ port: 8000 }, async (request) => {
  if (new URL(request.url).pathname === "/container-ready") return Response.json({ ready: true });
  if (new URL(request.url).pathname !== "/contract") return new Response(null, { status: 404 });
  const sql = createD1Sql();
  const passed: string[] = [];
  try {
    for (const testCase of BATCH_SQL_CASES) {
      await sql.migrate([
        { sql: "DROP TABLE IF EXISTS items" },
        { sql: "DROP TABLE IF EXISTS revision_guard" },
        { sql: "DROP TABLE IF EXISTS meta" },
        { sql: "DROP TABLE IF EXISTS extra" },
      ]);
      await initializeBatchSql(sql);
      await testCase.run(async () => sql);
      passed.push(testCase.name);
    }
    return Response.json({ passed });
  } catch (error) {
    return Response.json(
      { passed, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
