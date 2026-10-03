// SPDX-License-Identifier: MIT
/** Downloads use immutable published bytes, including files since removed from the project. */
import {
  canonicalLanguageTag,
  FileVersionsQuery,
  SCHEMA_VERSION,
  sha256Hex,
  type ExportQuery,
  type ExportResult,
  type FileVersionInfo,
  type FileVersionResult,
  type FileVersionsResult,
} from "@quaso/core";
import { notFound, ServiceError } from "./errors.ts";
import type { Sql, Store } from "./ports.ts";
import type { FileVersion } from "./publisher.ts";
import { settingsFromData } from "./settings.ts";
import type { Actor } from "./api.ts";
import { permissionReadStatements, permissionsFromRows, readPermissions } from "./permissions.ts";
import { validateActor, validateInput } from "./validation.ts";

type ReadSql = Pick<Sql, "read">;
/** Shared permission checks for the server and the Worker's direct R2 download route. */
export async function readPublishedFile(
  sql: Sql,
  store: Store | undefined,
  caller: Actor,
  input: unknown,
): Promise<FileVersionResult> {
  const actor = validateActor(caller);
  let request: { file: string; language: string };
  try {
    request = validateInput(FileVersionsQuery, input);
  } catch (error) {
    (await readPermissions(sql, actor)).require("read");
    throw error;
  }
  const protectedSql: ReadSql = {
    async read(statements) {
      const rows = await sql.read([...statements, ...permissionReadStatements(actor)]);
      permissionsFromRows(actor, rows.slice(statements.length)).require("read");
      return rows.slice(0, statements.length);
    },
  };
  return getPublishedFile(protectedSql, store, request);
}
function info(row: FileVersion): FileVersionInfo {
  return {
    id: row.id,
    language: row.language,
    file: row.file,
    sha256: row.sha256,
    size: row.size,
    revision: row.revision,
    publishedAt: row.published_at,
    replacedAt: row.replaced_at,
  };
}
async function content(store: Store | undefined, row: FileVersion): Promise<string> {
  if (store === undefined)
    throw new ServiceError("unavailable", "Published file storage is not configured.");
  const bytes = await store.read(row.store_key);
  if (bytes === null) throw new ServiceError("expired", "This published file version has expired.");
  if (sha256Hex(bytes) !== row.sha256)
    throw new ServiceError("unavailable", "The published file failed its integrity check.");
  return new TextDecoder().decode(bytes);
}
export async function getFileVersions(
  sql: ReadSql,
  input: { file: string; language: string },
): Promise<FileVersionsResult> {
  const [rows] = await sql.read([
    {
      sql: "SELECT * FROM file_versions WHERE file = ? AND language = ? ORDER BY published_at DESC, id DESC",
      params: [input.file, canonicalLanguageTag(input.language) ?? input.language],
    },
  ]);
  return { versions: (rows as unknown as FileVersion[]).map(info) };
}
export async function getFileVersion(
  sql: ReadSql,
  store: Store | undefined,
  input: { file: string; id: number },
): Promise<FileVersionResult> {
  const [rows] = await sql.read([
    {
      sql: "SELECT * FROM file_versions WHERE file = ? AND id = ?",
      params: [input.file, input.id],
    },
  ]);
  const row = rows[0] as unknown as FileVersion | undefined;
  if (row === undefined) throw notFound("File version");
  const text = await content(store, row);
  await sql.read([]);
  return { version: info(row), content: text };
}
export async function getPublishedFile(
  sql: ReadSql,
  store: Store | undefined,
  input: { file: string; language: string },
): Promise<FileVersionResult> {
  const [rows] = await sql.read([
    {
      sql: "SELECT * FROM file_versions WHERE file = ? AND language = ? AND replaced_at IS NULL",
      params: [input.file, canonicalLanguageTag(input.language) ?? input.language],
    },
  ]);
  const row = rows[0] as unknown as FileVersion | undefined;
  if (row === undefined) throw notFound("Published file");
  const text = await content(store, row);
  await sql.read([]);
  return { version: info(row), content: text };
}
export async function exportPublishedFiles(
  sql: ReadSql,
  store: Store | undefined,
  query: ExportQuery,
  model: string,
): Promise<ExportResult> {
  const at = Date.parse(query.at!);
  const languages = query.languages?.map((tag) => canonicalLanguageTag(tag) ?? tag);
  const [revision, settings, rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
    { sql: "SELECT data FROM settings WHERE id = 1" },
    {
      sql: `SELECT * FROM file_versions WHERE published_at <= ? AND (replaced_at IS NULL OR replaced_at > ?)
      AND (? = 1 OR language IN (SELECT value FROM json_each(?)))
      AND (? = 1 OR file IN (SELECT value FROM json_each(?))) ORDER BY language, file`,
      params: [
        at,
        at,
        languages === undefined ? 1 : 0,
        JSON.stringify(languages ?? []),
        query.files === undefined ? 1 : 0,
        JSON.stringify(query.files ?? []),
      ],
    },
  ]);
  const files = [];
  for (const row of rows as unknown as FileVersion[])
    files.push({
      path: row.file,
      language: row.language,
      content: await content(store, row),
      sha256: row.sha256,
    });
  await sql.read([]);
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: Number(revision[0]?.revision ?? 0),
    sourceLanguage: settingsFromData((settings[0]?.data as string) ?? null, model).sourceLanguage,
    files,
  };
}
