// SPDX-License-Identifier: MIT
/** Community endpoints, validated with the shared API schemas. */
import {
  CommentsQuery,
  CreateCommentRequest,
  CreateGlossaryTermRequest,
  CreateLanguageRequestRequest,
  GlossaryQuery,
  ReviewLanguageRequestRequest,
  UpdateGlossaryTermRequest,
} from "@quaso/core";
import type {
  CommentInfo,
  CommentsPage,
  GlossaryResult,
  GlossaryTerm,
  LanguageRequestInfo,
  LanguageRequestsResult,
} from "@quaso/core";
import { type ReadOptions, request } from "./api.ts";
import { validated } from "./forms.ts";
export const listGlossary = (query: GlossaryQuery, options: ReadOptions = {}) =>
  request<GlossaryResult>("/glossary", { query: { ...query }, ...options });
export const createGlossaryTerm = (body: CreateGlossaryTermRequest) =>
  request<GlossaryTerm>("/glossary", {
    method: "POST",
    body: validated(CreateGlossaryTermRequest, body),
  });
export const updateGlossaryTerm = (id: number, body: UpdateGlossaryTermRequest) =>
  request<GlossaryTerm>(`/glossary/${id}`, {
    method: "PATCH",
    body: validated(UpdateGlossaryTermRequest, body),
  });
export const deleteGlossaryTerm = (id: number) => request(`/glossary/${id}`, { method: "DELETE" });
export const listComments = (query: CommentsQuery, stringId?: number, options: ReadOptions = {}) =>
  request<CommentsPage>(stringId === undefined ? "/comments" : `/strings/${stringId}/comments`, {
    query: { ...query },
    ...options,
  });
export const addComment = (id: number, body: CreateCommentRequest) =>
  request<CommentInfo>(`/strings/${id}/comments`, {
    method: "POST",
    body: validated(CreateCommentRequest, body),
  });
export const resolveComment = (id: number) =>
  request<CommentInfo>(`/comments/${id}/resolve`, { method: "POST" });
export const deleteComment = (id: number) => request(`/comments/${id}`, { method: "DELETE" });
export const listLanguageRequests = (options: ReadOptions = {}) =>
  request<LanguageRequestsResult>("/language-requests", options);
export const requestLanguage = (body: CreateLanguageRequestRequest) =>
  request<LanguageRequestInfo>("/language-requests", {
    method: "POST",
    body: validated(CreateLanguageRequestRequest, body),
  });
export const reviewLanguageRequest = (id: number, body: ReviewLanguageRequestRequest) =>
  request<LanguageRequestInfo>(`/language-requests/${id}/review`, {
    method: "POST",
    body: validated(ReviewLanguageRequestRequest, body),
  });
