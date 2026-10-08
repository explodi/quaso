// SPDX-License-Identifier: MIT
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { resetUploadSql, UPLOAD_CASES } from "../../service/src/testing/upload_cases.ts";
import { measureUploads } from "../../service/src/testing/upload_measurements.ts";

Deno.serve({ port: 8000 }, async (request) => {
  if (new URL(request.url).pathname === "/container-ready") return Response.json({ ready: true });
  if (new URL(request.url).pathname !== "/upload") return new Response(null, { status: 404 });
  const sql = createD1Sql();
  const passed: string[] = [];
  const measurements: unknown[] = [];
  try {
    for (const testCase of UPLOAD_CASES) {
      console.log(`Upload contract: ${testCase.name}`);
      await resetUploadSql(sql);
      await testCase.run(sql);
      passed.push(testCase.name);
    }
    console.log("Measuring 3,000-string uploads");
    measurements.push(...(await measureUploads(sql)));
    return Response.json({ passed, measurements });
  } catch (error) {
    return Response.json(
      { passed, measurements, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
