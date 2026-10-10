// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals } from "@std/assert";
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
  assertEquals(doc.openapi, "3.1.0");
  assertEquals(doc.info.version, "1.2.3");
  assertEquals(doc.info.license, { name: "MIT", identifier: "MIT" });
  assertEquals(doc.servers, [{ url: "https://translate.example.com/api/v1" }]);
  assertEquals(doc.components.securitySchemes.apiKey, {
    type: "http",
    scheme: "bearer",
    description: "An API key (qso_…), from the Settings page or `quaso token create`",
  });
  assertEquals(doc.components.schemas.Error.properties.error.properties.code.enum, [
    ...ERROR_CODES,
  ]);
});

test("openapi: every route, with path parameters in braces", () => {
  assertEquals(Object.keys(doc.paths).sort(), [
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
    "/export",
    "/files",
    "/files/{file}/versions",
    "/files/{file}/versions/{id}",
    "/files/{id}",
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
    "/strings/{id}/translations/{lang}/llm-suggestion",
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
  assertEquals(Object.keys(doc.paths["/api-tokens"]).sort(), ["get", "post"]);
});

test("openapi: operation IDs are the service's method names", () => {
  const methods: (keyof ServiceApi)[] = API_ROUTES.map(
    (route) => route.operationId as keyof ServiceApi,
  );
  assertEquals(new Set(methods).size, methods.length);
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const operation of Object.values(operations as Json)) {
      assert(methods.includes((operation as Json).operationId), path);
    }
  }
});

test("openapi: query and path parameters from the core schemas", () => {
  const files = doc.paths["/files"].get;
  assertEquals([files.parameters[0].name, files.parameters[0].required], ["language", false]);
  const strings = doc.paths["/strings"].get;
  const byName = Object.fromEntries(strings.parameters.map((p: Json) => [p.name, p]));
  assertEquals(Object.keys(byName), ["language", "file", "state", "q", "ids", "cursor", "limit"]);
  assertEquals(byName.language.required, true);
  assertEquals(byName.language.in, "query");
  assertEquals(byName.limit, {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 500 },
  });
  assertEquals(byName.ids.style, "form");
  assertEquals(byName.ids.explode, false);
  assertEquals(byName.ids.schema.type, "array");

  const detail = doc.paths["/strings/{id}"].get;
  assertEquals(detail.parameters[0], {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  });
});

test("openapi: bodies, successes, errors and security", () => {
  const upload = doc.paths["/sources"].post;
  assertEquals(upload.requestBody.content["application/json"].schema, UploadRequest.toJsonSchema());
  assertEquals(upload.security, [{ apiKey: [] }, { session: [] }]);
  assertEquals(upload.responses["4XX"], { $ref: "#/components/responses/Error" });
  assertEquals(Object.keys(doc.paths["/api-tokens"].post.responses)[0], "201");
  assertEquals(doc.paths["/project"].get.security, [{}, { apiKey: [] }, { session: [] }]);
  assertEquals(doc.paths["/settings"].patch.security, [{ session: [] }], "people, not keys");
  assertEquals(doc.paths["/suggestions/review"].post.security, [{ session: [] }]);
  assertEquals(doc.paths["/restore"].post.security, [{ setupKey: [] }]);
  assertEquals(doc.components.securitySchemes.setupKey.name, "X-Setup-Key");
  assertEquals(doc.paths["/export"].get.description.startsWith("Access: An API key"), true);
});

test("openapi: LLM routes take an upload key or a manager's session", () => {
  const create = doc.paths["/jobs"].post;
  assertEquals(create.operationId, "createJob");
  assertEquals(create.security, [{ apiKey: [] }, { session: [] }]);
  assertEquals(
    create.description,
    "Access: An API key with the `upload` scope, or a signed-in manager or administrator.",
  );
  assertEquals(Object.keys(doc.paths["/jobs/{id}"]).sort(), ["delete", "get"]);
  const usage = doc.paths["/usage"].get;
  assertEquals(
    usage.parameters.map((p: Json) => p.name),
    ["period", "from", "to"],
  );
  assertEquals(usage.parameters[0].schema.enum, ["day", "month"]);
});
