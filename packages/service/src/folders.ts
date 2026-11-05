// SPDX-License-Identifier: MIT
/**
 * Folder context: text a person or a context file writes for a folder of the file tree, which
 * the LLM reads with every file beneath it, at any depth. The top folder, "", holds every file.
 * A folder exists while it holds an active file; its row in `folders` stays when it empties, and
 * applies again if files return to it.
 */
import type { FolderSettings, UpdateFolderRequest } from "@quaso/core";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision } from "./db.ts";
import { notFound } from "./errors.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Sql, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";

export type FolderRow = { path: string; context: string; uploaded_context: string | null };

export const FOLDER_ROWS: Statement = {
  sql: "SELECT path, context, uploaded_context FROM folders ORDER BY path",
};

/** The folders that hold a file, outermost first: `a/b/c.md` is in ``, `a` and `a/b`. */
export function foldersOf(filePath: string): string[] {
  const parts = filePath.split("/").slice(0, -1);
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

/** Every folder of the active files, sorted by path, with its context or "". */
export function folderSettings(filePaths: string[], rows: FolderRow[]): FolderSettings[] {
  const stored = new Map(rows.map((row) => [row.path, row]));
  const paths = new Set(filePaths.flatMap(foldersOf));
  return [...paths].sort().map((path) => ({
    path,
    context: stored.get(path)?.context ?? "",
    uploadedContext: stored.get(path)?.uploaded_context ?? null,
  }));
}

/** The contexts of a file's folders, outermost first, without blank ones. */
export function folderContextsOf(
  filePath: string,
  rows: Pick<FolderRow, "path" | "context">[],
): string[] {
  const contexts = new Map(rows.map((row) => [row.path, row.context]));
  return foldersOf(filePath)
    .map((folder) => contexts.get(folder) ?? "")
    .filter((context) => context.trim() !== "");
}

/**
 * The statement that stores a folder's context. A blank context removes its row, unless a
 * context file gave it text: the row then remembers that someone cleared that text here.
 */
function folderWrite(
  request: UpdateFolderRequest,
  uploaded: string | null,
  now: number,
): Statement {
  if (request.context.trim() === "") {
    if (uploaded === null) {
      return { sql: "DELETE FROM folders WHERE path = ?", params: [request.path] };
    }
    return {
      sql: "UPDATE folders SET context = '', updated_at = ? WHERE path = ?",
      params: [now, request.path],
    };
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

const UPLOADED_CONTEXT = "SELECT uploaded_context FROM folders WHERE path = ?";

function beneath(path: string): string {
  if (path === "") return "%";
  return `${path.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
}

function folderResult(request: UpdateFolderRequest, uploaded: string | null): FolderSettings {
  const blank = request.context.trim() === "";
  return {
    path: request.path,
    context: blank ? "" : request.context,
    uploadedContext: uploaded,
  };
}

/** `PATCH /folders` on the synchronous service. */
export function updateFolder(ctx: Context, request: UpdateFolderRequest): FolderSettings {
  const found = ctx.sql.query(HAS_ACTIVE_FILE, beneath(request.path));
  if (found.length === 0) throw notFound(`Folder ${request.path}`);
  const rows = ctx.sql.query<{ uploaded_context: string | null }>(UPLOADED_CONTEXT, request.path);
  const uploaded = rows[0]?.uploaded_context ?? null;
  const write = folderWrite(request, uploaded, ctx.clock());
  ctx.sql.run(write.sql, ...(write.params ?? []));
  bumpRevision(ctx.sql);
  return folderResult(request, uploaded);
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
      const [revision, found, stored, ...permissionRows] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: HAS_ACTIVE_FILE, params: [beneath(request.path)] },
        { sql: UPLOADED_CONTEXT, params: [request.path] },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          exists: found.length > 0,
          uploaded: (stored[0]?.uploaded_context as string | null | undefined) ?? null,
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ exists, uploaded, permissions }) => {
      permissions.require("context");
      if (!exists) throw notFound(`Folder ${request.path}`);
      return {
        statements: [folderWrite(request, uploaded, now)],
        result: folderResult(request, uploaded),
      };
    },
  );
}
