// SPDX-License-Identifier: MIT
/**
 * The OpenAPI 3.1 document (design §5.11), generated from the route table and the core
 * request schemas, so scripts and AI agents can read what the API accepts.
 */
import { API_BASE, ERROR_CODES, type JsonSchema, OptionalSchema, type Schema } from "@quaso/core";
import { SETUP_KEY_HEADER } from "./admin.ts";
import type { Access, ApiRoute } from "./api.ts";

export interface OpenApiOptions {
  version: string;
  publicUrl: string;
}

const ACCESS: Record<Access, string> = {
  anyone: "Anyone, without an API key.",
  read: "An API key with the `read` or `upload` scope, or a signed-in administrator.",
  upload: "An API key with the `upload` scope, or a signed-in administrator.",
  administrator: "A signed-in administrator.",
  setup: "Anyone with the configured setup key, in X-Setup-Key, until setup.",
  "signed in": "A signed-in person (the session cookie).",
  contributor: "A signed-in contributor, manager or administrator, in their languages.",
  manager: "A signed-in manager or administrator, in their languages.",
  translate: "An API key with the `upload` scope, or a signed-in manager or administrator.",
};

/**
 * How each kind of route is called, as OpenAPI security requirements (any one of them):
 * API keys have scopes, people sign in (the session cookie, whose role the service checks),
 * and the restore before setup takes the setup key.
 */
const SECURITY: Record<Access, Record<string, string[]>[]> = {
  anyone: [{}, { apiKey: [] }, { session: [] }],
  read: [{ apiKey: [] }, { session: [] }],
  upload: [{ apiKey: [] }, { session: [] }],
  translate: [{ apiKey: [] }, { session: [] }],
  administrator: [{ session: [] }],
  "signed in": [{ session: [] }],
  contributor: [{ session: [] }],
  manager: [{ session: [] }],
  setup: [{ setupKey: [] }],
};

/** The OpenAPI document for the routes. */
export function openApiDocument(routes: ApiRoute[], options: OpenApiOptions): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = route.path.replace(/:(\w+)(?:\([^)]*\))?/g, "{$1}");
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = operation(route);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Quaso API",
      version: options.version,
      description:
        "The HTTP API of a Quaso instance. Every error has the same shape: " +
        '`{ "error": { "code", "message", "details" } }`.',
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: `${options.publicUrl}${API_BASE}` }],
    tags: [...new Set(routes.map((route) => route.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "An API key (qso_…), from the Settings page or `quaso token create`",
        },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "quaso_session",
          description: "The website's session, from signing in (POST /auth/signin)",
        },
        setupKey: {
          type: "apiKey",
          in: "header",
          name: SETUP_KEY_HEADER,
          description: "The one-time setup key from the server's log, until setup is done",
        },
      },
      schemas: { Error: ERROR_SCHEMA },
      responses: {
        Error: {
          description: "An error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  };
}

function operation(route: ApiRoute): Record<string, unknown> {
  const parameters = [...parametersOf(route.params, "path"), ...parametersOf(route.query, "query")];
  const result: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    description: `Access: ${ACCESS[route.access]}`,
    tags: [route.tag],
    security: SECURITY[route.access],
  };
  if (parameters.length > 0) result.parameters = parameters;
  if (route.body) {
    result.requestBody = {
      required: !route.optionalBody,
      content: { "application/json": { schema: route.body.toJsonSchema() } },
    };
  }
  if (route.consumes) {
    result.requestBody = {
      required: true,
      content: Object.fromEntries(
        route.consumes.map((type) => [type, { schema: { type: "string", format: "binary" } }]),
      ),
    };
  }
  result.responses = {
    [String(route.status ?? 200)]: {
      description: "Success",
      content: route.produces
        ? Object.fromEntries(
            route.produces.map((type) => [type, { schema: { type: "string", format: "binary" } }]),
          )
        : { "application/json": { schema: { type: "object" } } },
    },
    "4XX": { $ref: "#/components/responses/Error" },
    "5XX": { $ref: "#/components/responses/Error" },
  };
  return result;
}

/** One parameter per property of an object schema. Lists are comma-separated. */
function parametersOf(
  schema: { shape: Record<string, Schema<unknown>> } | undefined,
  location: "path" | "query",
): Record<string, unknown>[] {
  if (!schema) return [];
  return Object.entries(schema.shape).map(([name, field]) => {
    const json = field.toJsonSchema();
    const parameter: Record<string, unknown> = {
      name,
      in: location,
      required: location === "path" || !(field instanceof OptionalSchema),
      schema: json,
    };
    if (typeof json.description === "string") parameter.description = json.description;
    if (json.type === "array") {
      parameter.style = "form";
      parameter.explode = false;
    }
    return parameter;
  });
}

const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", enum: [...ERROR_CODES] },
        message: { type: "string" },
        details: {
          type: "array",
          items: {
            type: "object",
            description:
              "Whatever applies: the file, key, language and check, or the path " +
              "in the request for validation errors",
            properties: Object.fromEntries(
              ["file", "key", "language", "check", "value", "form", "path", "message"]
                .map((name) => [name, { type: "string" }])
                .concat([
                  ["line", { type: "integer" }],
                  ["column", { type: "integer" }],
                ]),
            ),
          },
        },
        current: { description: "For conflicts on a translation: the current translation" },
      },
    },
  },
};
