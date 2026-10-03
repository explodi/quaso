// SPDX-License-Identifier: MIT
/** Community terminology, discussions and language requests, with the same HTTP contract in OpenAPI. */
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
import type { Actor } from "@quaso/service";
import type { HttpCall } from "../accounts.ts";
import { RATE_RULES } from "../rate_limit.ts";
import type { ApiRoute } from "./api.ts";
import { route } from "./route.ts";

const IdParams = s.object({ id: Id });

function limitCreation(http: HttpCall, actor: Actor): void {
  const user = actor.type === "user" ? String(actor.userId) : (http.ip ?? "unknown");
  http.accounts.limiter.check(
    [`community:ip:${http.ip ?? "unknown"}`, RATE_RULES.communityPerIp],
    [`community:user:${user}`, RATE_RULES.communityPerUser],
  );
}

export const LATER_ROUTES: ApiRoute[] = [
  route({
    method: "GET",
    path: "/glossary",
    operationId: "listGlossary",
    summary: "Browse and search terminology",
    tag: "Glossary",
    access: "anyone",
    query: GlossaryQuery,
    handle: ({ service, actor, query }) => service.listGlossary(actor, query),
  }),
  route({
    method: "POST",
    path: "/glossary",
    operationId: "createGlossaryTerm",
    summary: "Add a glossary term",
    tag: "Glossary",
    access: "manager",
    body: CreateGlossaryTermRequest,
    status: 201,
    handle: ({ service, actor, body }) => service.createGlossaryTerm(actor, body),
  }),
  route({
    method: "PATCH",
    path: "/glossary/:id",
    operationId: "updateGlossaryTerm",
    summary: "Change a glossary term",
    tag: "Glossary",
    access: "manager",
    params: IdParams,
    body: UpdateGlossaryTermRequest,
    handle: ({ service, actor, body, params }) =>
      service.updateGlossaryTerm(actor, { ...body, id: params.id }),
  }),
  route({
    method: "DELETE",
    path: "/glossary/:id",
    operationId: "deleteGlossaryTerm",
    summary: "Delete a glossary term",
    tag: "Glossary",
    access: "manager",
    params: IdParams,
    handle: ({ service, actor, params }) => service.deleteGlossaryTerm(actor, params),
  }),
  route({
    method: "GET",
    path: "/strings/:id/comments",
    operationId: "listStringComments",
    summary: "Read a string's discussions",
    tag: "Comments",
    access: "anyone",
    params: IdParams,
    query: CommentsQuery,
    handle: ({ service, actor, params, query }) =>
      service.listComments(actor, { ...query, stringId: params.id }),
  }),
  route({
    method: "GET",
    path: "/comments",
    operationId: "listComments",
    summary: "Review discussions and problems in the source text",
    tag: "Comments",
    access: "manager",
    query: CommentsQuery,
    handle: ({ service, actor, query }) => service.listComments(actor, query),
  }),
  route({
    method: "POST",
    path: "/strings/:id/comments",
    operationId: "addComment",
    summary: "Comment on a string (contributors and pending volunteers)",
    tag: "Comments",
    access: "signed in",
    params: IdParams,
    body: CreateCommentRequest,
    status: 201,
    handle: ({ service, actor, params, body, http }) => {
      limitCreation(http, actor);
      return service.addComment(actor, { ...body, stringId: params.id });
    },
  }),
  route({
    method: "POST",
    path: "/comments/:id/resolve",
    operationId: "resolveComment",
    summary: "Resolve a discussion (author or manager)",
    tag: "Comments",
    access: "signed in",
    params: IdParams,
    handle: ({ service, actor, params }) => service.resolveComment(actor, params),
  }),
  route({
    method: "DELETE",
    path: "/comments/:id",
    operationId: "deleteComment",
    summary: "Remove your comment (administrators may moderate anyone's)",
    tag: "Comments",
    access: "signed in",
    params: IdParams,
    handle: ({ service, actor, params }) => service.deleteComment(actor, params),
  }),
  route({
    method: "GET",
    path: "/language-requests",
    operationId: "listLanguageRequests",
    summary: "Pending community language requests and vote counts",
    tag: "Languages",
    access: "anyone",
    handle: ({ service, actor }) => service.listLanguageRequests(actor, {}),
  }),
  route({
    method: "POST",
    path: "/language-requests",
    operationId: "requestLanguage",
    summary: "Request a language or vote once for a pending request",
    tag: "Languages",
    access: "signed in",
    body: CreateLanguageRequestRequest,
    status: 201,
    handle: async ({ service, actor, body, http }) => {
      limitCreation(http, actor);
      await http.accounts.humanCheck(body.humanCheck, http.ip);
      const { humanCheck: _check, ...input } = body;
      return service.requestLanguage(actor, input);
    },
  }),
  route({
    method: "POST",
    path: "/language-requests/:id/review",
    operationId: "reviewLanguageRequest",
    summary: "Approve and add the language, or reject a request",
    tag: "Languages",
    access: "administrator",
    params: IdParams,
    body: ReviewLanguageRequestRequest,
    handle: ({ service, actor, params, body }) =>
      service.reviewLanguageRequest(actor, { ...body, id: params.id }),
  }),
];
