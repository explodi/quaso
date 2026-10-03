// SPDX-License-Identifier: MIT
/** The glossary, comments and language requests over local and remote storage. */
import type {
  CommentInfo,
  CommentsPage,
  CommentsQuery,
  CreateCommentRequest,
  CreateGlossaryTermRequest,
  CreateLanguageRequestRequest,
  GlossaryQuery,
  GlossaryResult,
  GlossaryTerm,
  LanguageRequestInfo,
  LanguageRequestsResult,
  ReviewLanguageRequestRequest,
  UpdateGlossaryTermRequest,
} from "@quaso/core";
import type { Actor } from "./api.ts";
export interface LaterApi {
  listGlossary(actor: Actor, input: GlossaryQuery): Promise<GlossaryResult>;
  createGlossaryTerm(actor: Actor, input: CreateGlossaryTermRequest): Promise<GlossaryTerm>;
  updateGlossaryTerm(
    actor: Actor,
    input: UpdateGlossaryTermRequest & { id: number },
  ): Promise<GlossaryTerm>;
  deleteGlossaryTerm(actor: Actor, input: { id: number }): Promise<{ ok: true }>;
  listComments(actor: Actor, input: CommentsQuery & { stringId?: number }): Promise<CommentsPage>;
  addComment(
    actor: Actor,
    input: CreateCommentRequest & { stringId: number },
  ): Promise<CommentInfo>;
  resolveComment(actor: Actor, input: { id: number }): Promise<CommentInfo>;
  deleteComment(actor: Actor, input: { id: number }): Promise<{ ok: true }>;
  listLanguageRequests(actor: Actor, input: Record<string, never>): Promise<LanguageRequestsResult>;
  requestLanguage(actor: Actor, input: CreateLanguageRequestRequest): Promise<LanguageRequestInfo>;
  reviewLanguageRequest(
    actor: Actor,
    input: ReviewLanguageRequestRequest & { id: number },
  ): Promise<LanguageRequestInfo>;
}
export const LATER_METHODS = [
  "listGlossary",
  "createGlossaryTerm",
  "updateGlossaryTerm",
  "deleteGlossaryTerm",
  "listComments",
  "addComment",
  "resolveComment",
  "deleteComment",
  "listLanguageRequests",
  "requestLanguage",
  "reviewLanguageRequest",
] as const satisfies readonly (keyof LaterApi)[];
export const LATER_SAFE_METHODS = ["listGlossary", "listComments", "listLanguageRequests"] as const;
