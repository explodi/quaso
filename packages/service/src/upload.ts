// SPDX-License-Identifier: MIT
import type { UploadRequest, UploadResult } from "@quaso/core";
import { type Author, authorFor, SYSTEM_AUTHOR } from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision, transaction } from "./db.ts";
import type { Clock, Sql } from "./ports.ts";
import { planUpload } from "./upload_plan.ts";
import {
  readUploadSnapshot,
  uploadReadStatements,
  uploadSnapshotFromRows,
} from "./upload_snapshot.ts";
import { withRetries } from "./write.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";

export { MAX_LENGTH_LIMIT } from "@quaso/core";

/** Permissions and creator metadata are refreshed with the upload on every retry. */
export async function uploadForActorAsync(
  sql: Sql,
  actor: Actor,
  request: UploadRequest,
  options: { model: string; clock: Clock; llmAvailable: boolean },
): Promise<UploadResult> {
  const now = options.clock();
  return withRetries(
    sql,
    async () => {
      const statements = uploadReadStatements(request);
      const permissions = permissionReadStatements(actor);
      const rows = await sql.read([
        ...statements,
        ...permissions,
        {
          sql: "SELECT name FROM api_tokens WHERE id = ?",
          params: [actor.type === "token" ? actor.tokenId : null],
        },
      ]);
      permissionsFromRows(
        actor,
        rows.slice(statements.length, statements.length + permissions.length),
      ).require("upload");
      const author: Author =
        actor.type === "user"
          ? { type: "user", id: actor.userId, label: null }
          : actor.type === "token"
            ? {
                type: "token",
                id: actor.tokenId,
                label: (rows.at(-1)?.[0]?.name as string | undefined) ?? null,
              }
            : SYSTEM_AUTHOR;
      const snapshot = uploadSnapshotFromRows(rows.slice(0, statements.length), options.model);
      return {
        revision: snapshot.revision,
        state: { snapshot: snapshot.state, revision: snapshot.revision, author },
      };
    },
    (state) =>
      planUpload(state.snapshot, request, state.author, state.revision, now, options.llmAvailable),
  );
}

/** Runs the shared upload decision in the synchronous service's transaction. */
export function upload(
  ctx: Context,
  actor: Actor,
  request: UploadRequest,
  llmAvailable = false,
): UploadResult {
  return transaction(ctx.sql, () => {
    const author = authorFor(ctx, actor);
    const rows = uploadReadStatements(request).map((statement) =>
      ctx.sql.query(statement.sql, ...(statement.params ?? [])),
    );
    const { revision, state } = uploadSnapshotFromRows(rows, ctx.defaultModel);
    const plan = planUpload(state, request, author, revision, ctx.clock(), llmAvailable);
    for (const statement of plan.statements)
      ctx.sql.run(statement.sql, ...(statement.params ?? []));
    if (plan.statements.length > 0) bumpRevision(ctx.sql);
    return plan.result;
  });
}

/** Read, decide and commit the same upload on either async database adapter. */
export async function uploadAsync(
  sql: Sql,
  author: Author,
  request: UploadRequest,
  options: { model: string; clock: Clock; llmAvailable: boolean },
): Promise<UploadResult> {
  const at = options.clock();
  return withRetries(
    sql,
    async () => {
      const { revision, state } = await readUploadSnapshot(sql, request, options.model);
      return { revision, state: { snapshot: state, revision } };
    },
    ({ snapshot, revision }) =>
      planUpload(snapshot, request, author, revision, at, options.llmAvailable),
  );
}
