// SPDX-License-Identifier: MIT
import type { UploadRequest } from "@quaso/core";
import { SYSTEM_AUTHOR } from "../actors.ts";
import type { Sql } from "../ports.ts";
import { uploadAsync } from "../upload.ts";
import { resetUploadSql } from "./upload_cases.ts";

/** Three fresh databases, with added, changed and unchanged 3,000-string uploads each. */
export async function measureUploads(sql: Sql) {
  const measurements: Awaited<ReturnType<typeof measureUpload>>[] = [];
  const files = (version: number) => [
    {
      path: "strings.json",
      repoPath: "strings.json",
      content: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 3000 }, (_, i) => [`key${i}`, `Text ${i} version ${version}`]),
        ),
      ),
    },
  ];
  for (let sample = 0; sample < 3; sample++) {
    await resetUploadSql(sql);
    measurements.push(
      await measureUpload(sql, "added", { files: files(0), languages: ["de"] }, sample),
    );
    measurements.push(await measureUpload(sql, "changed", { files: files(1) }, sample));
    measurements.push(await measureUpload(sql, "unchanged", { files: files(1) }, sample));
  }
  return measurements;
}

async function measureUpload(sql: Sql, operation: string, request: UploadRequest, sample: number) {
  let readMs = 0;
  let commitMs = 0;
  let readStatements = 0;
  let commitStatements = 0;
  let requestBytes = 0;
  let maximumParams = 0;
  const measured: Sql = {
    ...sql,
    async read(statements) {
      readStatements += statements.length;
      const started = performance.now();
      try {
        return await sql.read(statements);
      } finally {
        readMs += performance.now() - started;
      }
    },
    async commit(revision, statements) {
      commitStatements += statements.length + 1;
      requestBytes = new TextEncoder().encode(JSON.stringify(statements)).length;
      maximumParams = Math.max(...statements.map((statement) => statement.params?.length ?? 0));
      const started = performance.now();
      try {
        return await sql.commit(revision, statements);
      } finally {
        commitMs += performance.now() - started;
      }
    },
  };
  const started = performance.now();
  try {
    const result = await uploadAsync(measured, SYSTEM_AUTHOR, request, {
      model: "test",
      clock: Date.now,
      llmAvailable: true,
    });
    const elapsedMs = performance.now() - started;
    return {
      operation,
      sample,
      ok: true,
      elapsedMs,
      readMs,
      commitMs,
      decideMs: elapsedMs - readMs - commitMs,
      readStatements,
      commitStatements,
      requestBytes,
      maximumParams,
      revision: result.revision,
      added: result.added.length,
      changed: result.changed.length,
      job: result.job,
    };
  } catch (error) {
    return {
      operation,
      sample,
      ok: false,
      readMs,
      commitMs,
      readStatements,
      commitStatements,
      requestBytes,
      maximumParams,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
