// SPDX-License-Identifier: MIT
/** Validated service entry points for LATER-1 to LATER-3. */
import {
  CommentsQuery,
  CreateCommentRequest,
  CreateGlossaryTermRequest,
  CreateLanguageRequestRequest,
  GlossaryQuery,
  Id,
  ReviewLanguageRequestRequest,
  s,
  UpdateGlossaryTermRequest,
} from "@quaso/core";
import type { Call } from "./admin_service.ts";
import { addComment, deleteComment, listComments, resolveComment } from "./comments.ts";
import type { Context } from "./context.ts";
import {
  createGlossaryTerm,
  deleteGlossaryTerm,
  listGlossary,
  updateGlossaryTerm,
} from "./glossary.ts";
import {
  listLanguageRequests,
  requestLanguage,
  reviewLanguageRequest,
} from "./language_requests.ts";
import type { LaterApi } from "./later_api.ts";
const IdInput = s.object({ id: Id });
const Empty = s.object({});
export function laterMethods(ctx: Context, call: Call): LaterApi {
  return {
    listGlossary: (actor, input) =>
      call(actor, "read", GlossaryQuery, input, (q) => listGlossary(ctx, q)),
    createGlossaryTerm: (actor, input) =>
      call(actor, "glossary", CreateGlossaryTermRequest, input, (q, a) =>
        createGlossaryTerm(ctx, a, q),
      ),
    updateGlossaryTerm: (actor, input) =>
      call(
        actor,
        "glossary",
        UpdateGlossaryTermRequest.extend({ id: Id }),
        input,
        ({ id, ...q }, a) => updateGlossaryTerm(ctx, a, id, q),
      ),
    deleteGlossaryTerm: (actor, input) =>
      call(actor, "glossary", IdInput, input, ({ id }, a) => deleteGlossaryTerm(ctx, a, id)),
    listComments: (actor, input) =>
      call(actor, "read", CommentsQuery.extend({ stringId: Id.optional() }), input, (q, a) =>
        listComments(ctx, a, q),
      ),
    addComment: (actor, input) =>
      call(
        actor,
        "comment",
        CreateCommentRequest.extend({ stringId: Id }),
        input,
        ({ stringId, ...q }, a) => addComment(ctx, a, stringId, q),
      ),
    resolveComment: (actor, input) =>
      call(actor, null, IdInput, input, ({ id }, a) => resolveComment(ctx, a, id)),
    deleteComment: (actor, input) =>
      call(actor, null, IdInput, input, ({ id }, a) => deleteComment(ctx, a, id)),
    listLanguageRequests: (actor, input) =>
      call(actor, "read", Empty, input, (_q, a) => listLanguageRequests(ctx, a)),
    requestLanguage: (actor, input) =>
      call(actor, "requestLanguage", CreateLanguageRequestRequest, input, (q, a) =>
        requestLanguage(ctx, a, q),
      ),
    reviewLanguageRequest: (actor, input) =>
      call(
        actor,
        "settings",
        ReviewLanguageRequestRequest.extend({ id: Id }),
        input,
        ({ id, ...q }, a) => reviewLanguageRequest(ctx, a, id, q),
      ),
  };
}
