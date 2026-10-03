// SPDX-License-Identifier: MIT
/** Comments on strings, and the managers' list of problems in the source. */
import {
  canonicalLanguageTag,
  type CommentInfo,
  type CommentsPage,
  type CommentsQuery,
  type CreateCommentRequest,
} from "@quaso/core";
import { ActorDirectory, type ActorRows } from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision } from "./db.ts";
import { badRequest, notFound, ServiceError } from "./errors.ts";
import { requireLanguage } from "./languages.ts";
import {
  can,
  denied,
  requirePermission,
  permissionReadStatements,
  permissionsFromRows,
} from "./permissions.ts";
import type { Sql, SqlValue, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";

type Row = {
  id: number;
  string_id: number;
  path: string;
  display_key: string;
  language: string | null;
  body: string;
  source_issue: number;
  resolved_at: number | null;
  resolved_by: number | null;
  author_id: number | null;
  created_at: number;
};
const FROM = "comments c JOIN strings s ON s.id = c.string_id JOIN files f ON f.id = s.file_id";
const COLUMNS = "c.*, f.path, s.display_key";
const REVISION_READ: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

export function listComments(
  ctx: Context,
  actor: Actor,
  query: CommentsQuery & { stringId?: number },
): CommentsPage {
  if (query.stringId !== undefined) requireString(ctx, query.stringId);
  else requirePermission(ctx, actor, "issues");
  const tag = query.language === undefined ? undefined : requireLanguage(ctx, query.language).tag;
  const { count, page, offset } = commentStatements(query, tag);
  const total = ctx.sql.query<{ n: number }>(count.sql, ...(count.params ?? []))[0].n;
  const rows = ctx.sql.query<Row>(page.sql, ...(page.params ?? []));
  return commentsPage(infos(ctx, rows), total, offset);
}

function commentStatements(
  query: CommentsQuery & { stringId?: number },
  tag?: string,
): { count: Statement; page: Statement; offset: number } {
  const where = ["c.deleted_at IS NULL"];
  const values: SqlValue[] = [];
  if (query.stringId !== undefined) {
    where.push("c.string_id = ?");
    values.push(query.stringId);
  } else {
    where.push("c.source_issue = 1");
  }
  if (tag !== undefined) {
    where.push("(c.language IS NULL OR c.language = ?)");
    values.push(tag);
  }
  if (query.sourceIssue !== undefined) {
    where.push("c.source_issue = ?");
    values.push(query.sourceIssue ? 1 : 0);
  }
  if (query.resolved !== undefined) {
    where.push(`c.resolved_at IS ${query.resolved ? "NOT " : ""}NULL`);
  }
  const cursor = query.cursor ?? "0";
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
    throw badRequest("Invalid comments cursor.");
  }
  const offset = Number(cursor);
  const limit = query.limit ?? 50;
  const condition = where.join(" AND ");
  return {
    offset,
    count: { sql: `SELECT COUNT(*) AS n FROM ${FROM} WHERE ${condition}`, params: values },
    page: {
      sql: `SELECT ${COLUMNS} FROM ${FROM} WHERE ${condition} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      params: [...values, limit, offset],
    },
  };
}

/** Protected issue-list permissions and comments come from the same snapshot. */
export async function listCommentsAsync(
  sql: Sql,
  actor: Actor,
  query: CommentsQuery & { stringId?: number },
): Promise<CommentsPage> {
  const tag =
    query.language === undefined
      ? undefined
      : (canonicalLanguageTag(query.language) ?? query.language);
  const { count, page, offset } = commentStatements(query, tag);
  const [strings, languages, totals, rows, users, ...permissionRows] = await sql.read([
    {
      sql: "SELECT s.id FROM strings s JOIN files f ON f.id = s.file_id WHERE s.id = ? AND s.active = 1 AND f.active = 1 AND s.kind IN ('text', 'plural', 'ordinal')",
      params: [query.stringId ?? null],
    },
    { sql: "SELECT tag FROM languages WHERE tag = ?", params: [tag ?? null] },
    count,
    page,
    {
      sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN
      (SELECT author_id FROM (${page.sql}) UNION ALL SELECT resolved_by FROM (${page.sql}))`,
      params: [...(page.params ?? []), ...(page.params ?? [])],
    },
    ...permissionReadStatements(actor),
  ]);
  const permissions = permissionsFromRows(actor, permissionRows);
  permissions.require("read");
  if (query.stringId === undefined) permissions.require("issues");
  else if (strings.length === 0) throw notFound(`String ${query.stringId}`);
  if (query.language !== undefined && languages.length === 0)
    throw new ServiceError("not_found", `The project has no language ${query.language}.`);
  const actors = new ActorDirectory({ users: users as ActorRows["users"], tokens: [] });
  return commentsPage(commentInfos(rows as Row[], actors), Number(totals[0].n), offset);
}

function commentsPage(comments: CommentInfo[], total: number, offset: number): CommentsPage {
  return {
    comments,
    total,
    nextCursor: offset + comments.length < total ? String(offset + comments.length) : null,
  };
}

export function addComment(
  ctx: Context,
  actor: Actor,
  stringId: number,
  request: CreateCommentRequest,
): CommentInfo {
  requirePermission(ctx, actor, "comment");
  requireString(ctx, stringId);
  const body = request.body.trim();
  if (!body) throw badRequest("A comment cannot be blank.");
  const language =
    request.sourceIssue || !request.language
      ? null
      : requireLanguage(ctx, request.language, "bad_request").tag;
  requirePermission(ctx, actor, "comment", language ?? undefined);
  const [row] = ctx.sql.query<{ id: number }>(
    `INSERT INTO comments (string_id, language, body, source_issue, author_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    stringId,
    language,
    body,
    request.sourceIssue ? 1 : 0,
    actor.type === "user" ? actor.userId : null,
    ctx.clock(),
  );
  bumpRevision(ctx.sql);
  return infos(ctx, [get(ctx, row.id)])[0];
}

export function resolveComment(ctx: Context, actor: Actor, id: number): CommentInfo {
  const row = get(ctx, id);
  if (!owns(ctx, actor, row) && !can(ctx, actor, "review", row.language ?? undefined)) {
    throw denied(actor);
  }
  if (row.resolved_at === null) {
    ctx.sql.run(
      "UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?",
      ctx.clock(),
      actor.type === "user" ? actor.userId : null,
      id,
    );
    bumpRevision(ctx.sql);
  }
  return infos(ctx, [get(ctx, id)])[0];
}

export function deleteComment(ctx: Context, actor: Actor, id: number): { ok: true } {
  const row = get(ctx, id);
  if (!owns(ctx, actor, row) && !can(ctx, actor, "settings")) throw denied(actor);
  ctx.sql.run("UPDATE comments SET deleted_at = ? WHERE id = ?", ctx.clock(), id);
  bumpRevision(ctx.sql);
  return { ok: true };
}

export async function addCommentAsync(
  sql: Sql,
  actor: Actor,
  stringId: number,
  request: CreateCommentRequest,
  now: number,
): Promise<CommentInfo> {
  const language =
    request.sourceIssue || !request.language
      ? null
      : (canonicalLanguageTag(request.language) ?? request.language);
  const body = request.body.trim();
  const authorId = actor.type === "user" ? actor.userId : null;
  return withRetries(
    sql,
    async () => {
      const [revision, strings, languages, ids, users, ...permissionRows] = await sql.read([
        REVISION_READ,
        {
          sql: "SELECT f.path, s.display_key FROM strings s JOIN files f ON f.id = s.file_id WHERE s.id = ? AND s.active = 1 AND f.active = 1 AND s.kind IN ('text', 'plural', 'ordinal')",
          params: [stringId],
        },
        { sql: "SELECT tag FROM languages WHERE tag = ?", params: [language] },
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM comments" },
        { sql: "SELECT id, display_name, avatar_url FROM users WHERE id = ?", params: [authorId] },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          strings,
          languages,
          id: Number(ids[0].id),
          users: users as ActorRows["users"],
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ strings, languages, id, users, permissions }) => {
      permissions.require("comment");
      if (strings.length === 0) throw notFound(`String ${stringId}`);
      if (!body) throw badRequest("A comment cannot be blank.");
      if (language !== null && languages.length === 0)
        throw badRequest(`The project has no language ${request.language}.`);
      permissions.require("comment", language ?? undefined);
      const row: Row = {
        id,
        string_id: stringId,
        path: strings[0].path as string,
        display_key: strings[0].display_key as string,
        language,
        body,
        source_issue: request.sourceIssue ? 1 : 0,
        resolved_at: null,
        resolved_by: null,
        author_id: authorId,
        created_at: now,
      };
      return {
        statements: [
          {
            sql: "INSERT INTO comments (id, string_id, language, body, source_issue, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params: [id, stringId, language, body, row.source_issue, authorId, now],
          },
        ],
        result: commentInfos([row], new ActorDirectory({ users, tokens: [] }))[0],
      };
    },
  );
}

async function readCommentForChange(sql: Sql, actor: Actor, id: number) {
  const selection: Statement = {
    sql: `SELECT ${COLUMNS} FROM ${FROM} WHERE c.id = ? AND c.deleted_at IS NULL`,
    params: [id],
  };
  const [revision, rows, users, ...permissionRows] = await sql.read([
    REVISION_READ,
    selection,
    {
      sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN
      (SELECT author_id FROM (${selection.sql}) UNION ALL SELECT resolved_by FROM (${selection.sql}) UNION ALL SELECT ?)`,
      params: [id, id, actor.type === "user" ? actor.userId : null],
    },
    ...permissionReadStatements(actor),
  ]);
  return {
    revision: Number(revision[0].revision),
    state: {
      row: rows[0] as Row | undefined,
      permissions: permissionsFromRows(actor, permissionRows),
      actors: new ActorDirectory({ users: users as ActorRows["users"], tokens: [] }),
    },
  };
}

export async function resolveCommentAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  now: number,
): Promise<CommentInfo> {
  return withRetries(
    sql,
    () => readCommentForChange(sql, actor, id),
    ({ row, permissions, actors }) => {
      if (row === undefined) throw notFound(`Comment ${id}`);
      const owner =
        actor.type === "user" && row.author_id === actor.userId && permissions.can("account");
      if (!owner && !permissions.can("review", row.language ?? undefined)) throw denied(actor);
      if (row.resolved_at !== null)
        return { statements: [], result: commentInfos([row], actors)[0] };
      const resolved = {
        ...row,
        resolved_at: now,
        resolved_by: actor.type === "user" ? actor.userId : null,
      };
      return {
        statements: [
          {
            sql: "UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?",
            params: [now, resolved.resolved_by, id],
          },
        ],
        result: commentInfos([resolved], actors)[0],
      };
    },
  );
}

export async function deleteCommentAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  now: number,
): Promise<{ ok: true }> {
  return withRetries(
    sql,
    () => readCommentForChange(sql, actor, id),
    ({ row, permissions }) => {
      if (row === undefined) throw notFound(`Comment ${id}`);
      const owner =
        actor.type === "user" && row.author_id === actor.userId && permissions.can("account");
      if (!owner && !permissions.can("settings")) throw denied(actor);
      return {
        statements: [{ sql: "UPDATE comments SET deleted_at = ? WHERE id = ?", params: [now, id] }],
        result: { ok: true as const },
      };
    },
  );
}

function owns(ctx: Context, actor: Actor, row: Row): boolean {
  return actor.type === "user" && row.author_id === actor.userId && can(ctx, actor, "account");
}
function requireString(ctx: Context, id: number): void {
  if (
    !ctx.sql.query(
      `SELECT 1 FROM strings s JOIN files f ON f.id = s.file_id WHERE s.id = ? AND s.active = 1 AND f.active = 1 AND s.kind IN ('text', 'plural', 'ordinal')`,
      id,
    ).length
  )
    throw notFound(`String ${id}`);
}
function get(ctx: Context, id: number): Row {
  const [row] = ctx.sql.query<Row>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE c.id = ? AND c.deleted_at IS NULL`,
    id,
  );
  if (!row) throw notFound(`Comment ${id}`);
  return row;
}
function infos(ctx: Context, rows: Row[]): CommentInfo[] {
  const actors = new ActorDirectory(
    ctx.sql,
    [],
    rows.flatMap((row) => [row.author_id, row.resolved_by]),
  );
  return commentInfos(rows, actors);
}

function commentInfos(rows: Row[], actors: ActorDirectory): CommentInfo[] {
  return rows.map((row) => ({
    id: row.id,
    stringId: row.string_id,
    file: row.path,
    key: row.display_key,
    language: row.language,
    body: row.body,
    sourceIssue: row.source_issue === 1,
    resolvedAt: row.resolved_at,
    resolvedBy: actors.user(row.resolved_by),
    author: actors.user(row.author_id) ?? { type: "system", id: null, name: "System" },
    createdAt: row.created_at,
  }));
}
