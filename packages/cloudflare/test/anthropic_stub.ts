// SPDX-License-Identifier: MIT
import type { StubRequest } from "./gemini_stub.ts";

export const ANTHROPIC_STUB_URL = "http://anthropic.test";
export const ANTHROPIC_STUB_KEY = "sk-ant-stub-key";

/** An offline Messages API reached through workerd's real fetch. */
export async function anthropicStub(request: StubRequest): Promise<Response> {
  if (request.headers.get("x-api-key") !== ANTHROPIC_STUB_KEY) {
    return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
  }
  if (request.headers.get("anthropic-version") !== "2023-06-01") {
    return Response.json({ error: { message: "Missing API version" } }, { status: 400 });
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    return Response.json({ data: [{ id: "claude-stub" }], has_more: false });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  }
  const body = JSON.parse(await request.text()) as {
    model: string;
    output_config?: { format: { type: string; schema: { additionalProperties?: boolean } } };
  };
  if (body.model === "claude-moved") {
    return new Response(null, {
      status: 302,
      headers: { Location: `${ANTHROPIC_STUB_URL}/followed-a-redirect` },
    });
  }
  if (body.output_config && body.output_config.format.schema.additionalProperties !== false) {
    return Response.json(
      { error: { message: "Expected a closed output schema" } },
      { status: 400 },
    );
  }
  const text = body.output_config
    ? JSON.stringify({ translations: [{ id: "s1", text: "Spielen" }] })
    : "The texts of a game's menus.";
  return Response.json({
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 30 },
  });
}
