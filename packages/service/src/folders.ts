// SPDX-License-Identifier: MIT
/**
 * Folder context: text a person writes for a folder of the file tree, which the LLM reads with
 * every file beneath it, at any depth. A folder exists while it holds an active file; its row
 * in `folders` stays when it empties, and applies again if files return to it.
 */
import type { FolderSettings, UpdateFolderRequest } from "@quaso/core";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision } from "./db.ts";
import { notFound } from "./errors.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Sql, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";

export type FolderRow = { path: string; context: string };

export const FOLDER_ROWS: Statement = { sql: "SELECT path, context FROM folders ORDER BY path" };

/** The folders that hold a file, outermost first: `a/b/c.md` is in `a` and `a/b`. */
export function foldersOf(filePath: string): string[] {
  const parts = filePath.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Every folder of the active files, sorted by path, with its context or "". */
export function folderSettings(filePaths: string[], rows: FolderRow[]): FolderSettings[] {
  const contexts = new Map(rows.map((row) => [row.path, row.context]));
  const paths = new Set(filePaths.flatMap(foldersOf));
  return [...paths].sort().map((path) => ({ path, context: contexts.get(path) ?? "" }));
}

/** The contexts of a file's folders, outermost first, without blank ones. */
export function folderContextsOf(filePath: string, rows: FolderRow[]): string[] {
  const contexts = new Map(rows.map((row) => [row.path, row.context]));
  return foldersOf(filePath)
    .map((folder) => contexts.get(folder) ?? "")
    .filter((context) => context.trim() !== "");
}

/** The statement that stores a folder's context; a blank context removes its row. */
function folderWrite(request: UpdateFolderRequest, now: number): Statement {
  if (request.context.trim() === "") {
    return { sql: "DELETE FROM folders WHERE path = ?", params: [request.path] };
  }
  return {
    sql: `INSERT INTO folders (path, context, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET context = excluded.context, updated_at = excluded.updated_at`,
    params: [request.path, request.context, now],
  };
}

// A folder is named by its files: one with no active file beneath it isn't on the Settings page.
const HAS_ACTIVE_FILE =
  "SELECT 1 AS found FROM files WHERE active = 1 AND path LIKE ? ESCAPE '\\' LIMIT 1";

function beneath(path: string): string {
  return `${path.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
}

function folderResult(request: UpdateFolderRequest): FolderSettings {
  const blank = request.context.trim() === "";
  return { path: request.path, context: blank ? "" : request.context };
}

/** `PATCH /folders` on the synchronous service. */
export function updateFolder(ctx: Context, request: UpdateFolderRequest): FolderSettings {
  const found = ctx.sql.query(HAS_ACTIVE_FILE, beneath(request.path));
  if (found.length === 0) throw notFound(`Folder ${request.path}`);
  const write = folderWrite(request, ctx.clock());
  ctx.sql.run(write.sql, ...(write.params ?? []));
  bumpRevision(ctx.sql);
  return folderResult(request);
}

/** `PATCH /folders`: managers and administrators write the context of a folder. */
export async function updateFolderAsync(
  sql: Sql,
  actor: Actor,
  request: UpdateFolderRequest,
  now: number,
): Promise<FolderSettings> {
  return withRetries(
    sql,
    async () => {
      const [revision, found, ...permissionRows] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: HAS_ACTIVE_FILE, params: [beneath(request.path)] },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          exists: found.length > 0,
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ exists, permissions }) => {
      permissions.require("context");
      if (!exists) throw notFound(`Folder ${request.path}`);
      return { statements: [folderWrite(request, now)], result: folderResult(request) };
    },
  );
}
