// SPDX-License-Identifier: MIT
/**
 * The HTTP API's routes under `/api/v1` (design §5.11), as one table: the router serves it
 * and the OpenAPI document is generated from it. Each route checks its input against the
 * core request schemas, then calls one service method with the actor; the service decides
 * what the actor may do.
 */
import {
  CreateApiTokenRequest,
  ExportQuery,
  FilePath,
  Id,
  ImportRequest,
  LanguageTag,
  type ObjectSchema,
  s,
  type Schema,
  StringsQuery,
  StringsQueueQuery,
  UploadRequest,
} from "@quaso/core";
import type { Actor, ServiceApi } from "@quaso/service";
import type { Authenticator } from "../auth.ts";
import { MB } from "../http/request.ts";
import type { HttpCall } from "../accounts.ts";
import { ACCOUNT_ROUTES } from "./accounts.ts";
import { ADMIN_ROUTES, type RouteHost } from "./admin.ts";
import { JOB_ROUTES } from "./jobs.ts";
import { LATER_ROUTES } from "./later.ts";
import { route } from "./route.ts";

/** Who may call a route, for the documentation. The service enforces it. */
export type Access =
  | "anyone"
  | "read"
  | "upload"
  | "administrator"
  | "setup"
  /** A signed-in person; `contributor` and `manager` also say which roles the service allows. */
  | "signed in"
  | "contributor"
  | "manager"
  /** LLM jobs and usage: an API key with the `upload` scope, or a manager or administrator. */
  | "translate";

/** What a route's handler gets: its input checked against its schemas. */
export interface ApiCall<P, Q, B> {
  service: ServiceApi;
  actor: Actor;
  auth: Authenticator;
  params: P;
  query: Q;
  body: B;
  /** The request, for routes that read its body or headers themselves. */
  request: Request;
  /** What the server knows besides the service: its version, setup, log and storage. */
  host: RouteHost;
  /** The client's address, the session, and the server's account helpers (Sprint 6). */
  http: HttpCall;
}
type AnyObjectSchema = ObjectSchema<any>;

export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below `/api/v1`, in `URLPattern` syntax, such as `/strings/:id`. */
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  access: Access;
  params?: AnyObjectSchema;
  query?: AnyObjectSchema;
  body?: Schema<unknown>;
  /** The largest body, in bytes. Default: 1 MB. */
  bodyLimit?: number;
  /** The status on success. Default: 200. */
  status?: number;
  /** The JSON body may be left out: it is then `{}` (and `If-Match` may carry the revision). */
  optionalBody?: boolean;
  /** The media types of a file the route answers with, instead of JSON (for the documentation). */
  produces?: string[];
  /** The media types of a file the route takes as its body, instead of JSON. */
  consumes?: string[];
  /** The result as JSON, or a `Response` sent as it is (a file). */
  handle(call: ApiCall<any, any, any>): Promise<unknown>;
}

export const IdParams = s.object({ id: Id });
export const LanguageQuery = s.object({ language: LanguageTag });
export const OptionalLanguageQuery = s.object({
  language: LanguageTag.optional().describe("Only this language"),
});
export const ActivityQuery = s.object({
  cursor: s.string().optional().describe("The nextCursor of the previous page"),
  limit: s.integer({ min: 1, max: 200 }).optional(),
});

export const API_ROUTES: ApiRoute[] = [
  ...LATER_ROUTES,
  route({
    method: "GET",
    path: "/project",
    operationId: "getProject",
    summary: "The project, its languages and their progress",
    tag: "Project",
    access: "anyone",
    handle: ({ service, actor }) => service.getProject(actor, {}),
  }),
  route({
    method: "GET",
    path: "/files",
    operationId: "listFiles",
    summary: "Source files, or files with their progress in a language",
    tag: "Project",
    access: "anyone",
    query: OptionalLanguageQuery,
    handle: ({ service, actor, query }) => service.listFiles(actor, query),
  }),
  route({
    method: "GET",
    path: "/strings",
    operationId: "listStrings",
    summary: "Strings in a language, for the editor: filtered, searched and paged",
    tag: "Strings",
    access: "anyone",
    query: StringsQuery,
    handle: ({ service, actor, query }) => service.listStrings(actor, query),
  }),
  route({
    method: "GET",
    path: "/strings/queue",
    operationId: "getStringsQueue",
    summary: "String IDs with untranslated and outdated work first, fixed when the queue opens",
    tag: "Strings",
    access: "anyone",
    query: StringsQueueQuery,
    handle: ({ service, actor, query }) => service.getStringsQueue(actor, query),
  }),
  route({
    method: "GET",
    path: "/strings/:id",
    operationId: "getString",
    summary: "One string in a language, with its suggestions, checks and other languages",
    tag: "Strings",
    access: "anyone",
    params: IdParams,
    query: LanguageQuery,
    handle: ({ service, actor, params, query }) =>
      service.getString(actor, { id: params.id, language: query.language }),
  }),
  route({
    method: "GET",
    path: "/strings/:id/history",
    operationId: "getHistory",
    summary: "A string's history, in one language or all",
    tag: "Strings",
    access: "anyone",
    params: IdParams,
    query: OptionalLanguageQuery,
    handle: ({ service, actor, params, query }) =>
      service.getHistory(actor, { id: params.id, ...query }),
  }),
  route({
    method: "GET",
    path: "/activity",
    operationId: "getActivity",
    summary: "Recent uploads, jobs, reviews and imports",
    tag: "Project",
    access: "anyone",
    query: ActivityQuery,
    handle: ({ service, actor, query }) => service.getActivity(actor, query),
  }),
  route({
    method: "GET",
    path: "/status",
    operationId: "getStatus",
    summary: "Counts per language and per file (quaso status)",
    tag: "CLI",
    access: "read",
    query: OptionalLanguageQuery,
    handle: ({ service, actor, query }) => service.getStatus(actor, query),
  }),
  route({
    method: "POST",
    path: "/sources",
    operationId: "upload",
    summary: "Upload the source files (quaso upload)",
    tag: "CLI",
    access: "upload",
    body: UploadRequest,
    bodyLimit: 50 * MB,
    handle: ({ service, actor, body }) => service.upload(actor, body),
  }),
  route({
    method: "GET",
    path: "/export",
    operationId: "exportFiles",
    summary: "Every language's files, rendered (quaso download)",
    tag: "CLI",
    access: "read",
    query: ExportQuery,
    handle: ({ service, actor, query }) => service.exportFiles(actor, query),
  }),
  route({
    method: "GET",
    path: "/files/:file(.+)/versions",
    operationId: "getFileVersions",
    summary: "Published versions of a file",
    tag: "CLI",
    access: "read",
    params: s.object({ file: FilePath }),
    query: s.object({ language: LanguageTag }),
    handle: ({ service, actor, params, query }) =>
      service.getFileVersions(actor, { ...params, ...query }),
  }),
  route({
    method: "GET",
    path: "/files/:file(.+)/versions/:id",
    operationId: "getFileVersion",
    summary: "A published version and its content",
    tag: "CLI",
    access: "read",
    params: s.object({ file: FilePath, id: Id }),
    handle: ({ service, actor, params }) => service.getFileVersion(actor, params),
  }),
  route({
    method: "POST",
    path: "/imports",
    operationId: "importTranslations",
    summary: "Import existing translation files (quaso import)",
    tag: "CLI",
    access: "upload",
    body: ImportRequest,
    bodyLimit: 50 * MB,
    handle: ({ service, actor, body }) => service.importTranslations(actor, body),
  }),
  route({
    method: "GET",
    path: "/api-tokens",
    operationId: "listApiTokens",
    summary: "The API keys",
    tag: "API keys",
    access: "administrator",
    handle: ({ service, actor }) => service.listApiTokens(actor, {}),
  }),
  route({
    method: "POST",
    path: "/api-tokens",
    operationId: "createApiToken",
    summary: "Create an API key; its secret is shown only in this response",
    tag: "API keys",
    access: "administrator",
    body: CreateApiTokenRequest,
    status: 201,
    handle: ({ service, actor, body }) => service.createApiToken(actor, body),
  }),
  route({
    method: "DELETE",
    path: "/api-tokens/:id",
    operationId: "revokeApiToken",
    summary: "Revoke an API key",
    tag: "API keys",
    access: "administrator",
    params: IdParams,
    handle: async ({ service, actor, auth, params }) => {
      const result = await service.revokeApiToken(actor, { id: params.id });
      auth.forget(params.id);
      return result;
    },
  }),
  ...ADMIN_ROUTES,
  ...ACCOUNT_ROUTES,
  ...JOB_ROUTES,
];
