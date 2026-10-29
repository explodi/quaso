// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { ERROR_CODES, UploadRequest } from "@quaso/core";
import type { ServiceApi } from "@quaso/service";
import { API_ROUTES } from "./api.ts";
import { openApiDocument } from "./openapi.ts";
type Json = any;

const doc: Json = openApiDocument(API_ROUTES, {
  version: "1.2.3",
  publicUrl: "https://translate.example.com",
});

test("openapi: an OpenAPI 3.1 document for the instance", () => {
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.info.version).toBe("1.2.3");
  expect(doc.info.license).toStrictEqual({ name: "MIT", identifier: "MIT" });
  expect(doc.servers).toStrictEqual([{ url: "https://translate.example.com/api/v1" }]);
  expect(doc.components.securitySchemes.apiKey).toStrictEqual({
    type: "http",
    scheme: "bearer",
    description:
      "Personal API keys (qso_…) are created in Account → API keys and limited by scope and the creator's role. Server-created keys use their scope alone.",
  });
  expect(doc.components.schemas.Error.properties.error.properties.code.enum).toStrictEqual([
    ...ERROR_CODES,
  ]);
});

test("openapi: every route, with path parameters in braces", () => {
  expect(Object.keys(doc.paths).sort()).toStrictEqual([
    "/account",
    "/account/identities/{provider}",
    "/activity",
    "/admin",
    "/api-tokens",
    "/api-tokens/{id}",
    "/auth/email-link",
    "/auth/email-link/request",
    "/auth/password-reset",
    "/auth/password-reset/request",
    "/auth/session",
    "/auth/setup",
    "/auth/signin",
    "/auth/signout",
    "/auth/signup",
    "/auth/verify-email",
    "/backup",
    "/comments",
    "/comments/{id}",
    "/comments/{id}/resolve",
    "/conversions/icu",
    "/export",
    "/files",
    "/files/{file}/versions",
    "/files/{file}/versions/{id}",
    "/files/{id}",
    "/folders",
    "/glossary",
    "/glossary/{id}",
    "/imports",
    "/invites/{token}",
    "/jobs",
    "/jobs/{id}",
    "/language-requests",
    "/language-requests/{id}/review",
    "/languages",
    "/languages/{tag}",
    "/llm-suggestions",
    "/models",
    "/project",
    "/quality-jobs",
    "/quality-jobs/{id}",
    "/quality-jobs/{id}/suggestions/{index}",
    "/renames",
    "/restore",
    "/settings",
    "/settings/email/test",
    "/settings/llm/test",
    "/settings/secrets",
    "/settings/secrets/{name}",
    "/sources",
    "/status",
    "/strings",
    "/strings/queue",
    "/strings/{id}",
    "/strings/{id}/comments",
    "/strings/{id}/history",
    "/strings/{id}/suggestions/{lang}",
    "/strings/{id}/translations/{lang}",
    "/strings/{id}/translations/{lang}/approve",
    "/strings/{id}/translations/{lang}/unapprove",
    "/suggestions",
    "/suggestions/review",
    "/suggestions/{id}",
    "/team/invites",
    "/team/invites/{id}",
    "/team/members",
    "/team/members/{id}",
    "/team/members/{id}/reset-link",
    "/team/volunteer-requests",
    "/team/volunteer-requests/{userId}",
    "/usage",
    "/volunteer-requests",
  ]);
  expect(Object.keys(doc.paths["/api-tokens"]).sort()).toStrictEqual(["get", "post"]);
});

test("openapi: operation IDs are the service's method names", () => {
  const methods: (keyof ServiceApi)[] = API_ROUTES.map(
    (route) => route.operationId as keyof ServiceApi,
  );
  expect(new Set(methods).size).toStrictEqual(methods.length);
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const operation of Object.values(operations as Json)) {
      assert(methods.includes((operation as Json).operationId), path);
    }
  }
});

test("openapi: query and path parameters from the core schemas", () => {
  const files = doc.paths["/files"].get;
  expect([files.parameters[0].name, files.parameters[0].required]).toStrictEqual([
    "language",
    false,
  ]);
  const strings = doc.paths["/strings"].get;
  const byName = Object.fromEntries(strings.parameters.map((p: Json) => [p.name, p]));
  expect(Object.keys(byName)).toStrictEqual([
    "language",
    "file",
    "state",
    "q",
    "ids",
    "cursor",
    "limit",
  ]);
  expect(byName.language.required).toBe(true);
  expect(byName.language.in).toBe("query");
  expect(byName.limit).toStrictEqual({
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 500 },
  });
  expect(byName.ids.style).toBe("form");
  expect(byName.ids.explode).toBe(false);
  expect(byName.ids.schema.type).toBe("array");

  const detail = doc.paths["/strings/{id}"].get;
  expect(detail.parameters[0]).toStrictEqual({
    name: "id",
    in: "path",
    required: true,
    schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  });
});

test("openapi: bodies, successes, errors and security", () => {
  const upload = doc.paths["/sources"].post;
  expect(upload.requestBody.content["application/json"].schema).toStrictEqual(
    UploadRequest.toJsonSchema(),
  );
  expect(upload.security).toStrictEqual([{ apiKey: [] }, { session: [] }]);
  expect(upload.responses["4XX"]).toStrictEqual({ $ref: "#/components/responses/Error" });
  expect(Object.keys(doc.paths["/api-tokens"].post.responses)[0]).toBe("201");
  expect(doc.paths["/project"].get.security).toStrictEqual([{}, { apiKey: [] }, { session: [] }]);
  expect(doc.paths["/settings"].patch.security, "people, not keys").toStrictEqual([
    { session: [] },
  ]);
  expect(doc.paths["/suggestions/review"].post.security).toStrictEqual([{ session: [] }]);
  expect(doc.paths["/restore"].post.security).toStrictEqual([{ setupKey: [] }]);
  expect(doc.components.securitySchemes.setupKey.name).toBe("X-Setup-Key");
  expect(doc.paths["/export"].get.description.startsWith("Access: An API key")).toBe(true);
});

test("openapi: LLM routes take an upload key or a manager's session", () => {
  const create = doc.paths["/jobs"].post;
  expect(create.operationId).toBe("createJob");
  expect(create.security).toStrictEqual([{ apiKey: [] }, { session: [] }]);
  expect(create.description).toStrictEqual(
    "Access: An API key with the `upload` scope, or a signed-in manager or administrator.",
  );
  expect(Object.keys(doc.paths["/jobs/{id}"]).sort()).toStrictEqual(["delete", "get"]);
  const usage = doc.paths["/usage"].get;
  expect(usage.parameters.map((p: Json) => p.name)).toStrictEqual(["period", "from", "to"]);
  expect(usage.parameters[0].schema.enum).toStrictEqual(["day", "month"]);
});
