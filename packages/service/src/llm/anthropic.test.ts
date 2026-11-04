// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import type { Fetch } from "@quaso/core";
import { createAnthropicProvider, toAnthropicSchema, type AnthropicOptions } from "./anthropic.ts";
import { ProviderError, type ProviderRequest } from "./provider.ts";
import { RESPONSE_SCHEMA } from "./prompt.ts";

const KEY = "sk-ant-test-only-12345678";
const REQUEST: ProviderRequest = {
  model: "claude-haiku-5-5",
  system: "Translate app text, preserving placeholders.",
  prompt: "Translate into German: Hello, {{name}}!",
  responseSchema: RESPONSE_SCHEMA,
  safety: "permissive",
};
const ANSWER = { translations: [{ id: "s1", text: "Hallo, {{name}}!" }] };
const MESSAGE = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(ANSWER) }],
  usage: { input_tokens: 100, output_tokens: 30 },
};
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
function provider(answers: (Response | Error)[], options: Partial<AnthropicOptions> = {}) {
  const sent: { url: string; init: RequestInit; body: Record<string, unknown> | null }[] = [];
  const waits: number[] = [];
  const fetch: Fetch = (input, init) => {
    sent.push({
      url: String(input),
      init: init ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("No scripted response");
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  const anthropic = createAnthropicProvider({
    apiKey: KEY,
    fetch,
    random: () => 0.5,
    now: () => Date.UTC(2026, 10, 4),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { anthropic, sent, waits };
}

test("anthropic: sends native structured output and keeps credentials in headers", async () => {
  const { anthropic, sent } = provider([json(MESSAGE)]);
  const result = await anthropic.translate(REQUEST);
  expect(result.answer).toStrictEqual(ANSWER);
  expect(result.usage).toStrictEqual({ inputTokens: 100, outputTokens: 30, thinkingTokens: 0 });
  expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages");
  expect(sent[0].init.method).toBe("POST");
  expect(sent[0].init.redirect).toBe("manual");
  expect(new Headers(sent[0].init.headers).get("x-api-key")).toStrictEqual(KEY);
  expect(new Headers(sent[0].init.headers).get("anthropic-version")).toBe("2023-06-01");
  expect(sent[0].body).toStrictEqual({
    model: REQUEST.model,
    max_tokens: 16_384,
    system: REQUEST.system,
    messages: [{ role: "user", content: REQUEST.prompt }],
    output_config: { format: { type: "json_schema", schema: toAnthropicSchema(RESPONSE_SCHEMA) } },
  });
  expect(JSON.stringify(sent[0].body).includes(KEY)).toBe(false);
  expect(sent[0].url.includes(KEY)).toBe(false);
});

test("anthropic: schema closes nested objects without requiring optional fields", () => {
  expect(
    toAnthropicSchema({
      type: "object",
      required: ["id"],
      propertyOrdering: ["id"],
      properties: {
        id: { type: "string" },
        notes: {
          type: "array",
          items: { type: "object", properties: { note: { type: "string" } } },
        },
      },
    }),
  ).toStrictEqual({
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string" },
      notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { note: { type: "string" } },
        },
      },
    },
  });
});

test("anthropic: text generation ignores thinking and counts cached input without double-counting output", async () => {
  const { anthropic, sent } = provider([
    json({
      ...MESSAGE,
      content: [
        { type: "thinking", thinking: "Private thought" },
        { type: "text", text: " Menus of a game. " },
      ],
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
        output_tokens_details: { thinking_tokens: 10 },
      },
    }),
  ]);
  const result = await anthropic.generateText(REQUEST);
  expect(result.text).toBe("Menus of a game.");
  expect(result.usage).toStrictEqual({ inputTokens: 150, outputTokens: 30, thinkingTokens: 10 });
  expect(sent[0].body?.output_config).toBe(undefined);
});

test("anthropic: refusals retain usage and become blocked results", async () => {
  const { anthropic } = provider([
    json({ ...MESSAGE, stop_reason: "refusal" }),
    json({ ...MESSAGE, stop_reason: "refusal" }),
  ]);
  expect(await anthropic.translate(REQUEST)).toStrictEqual({
    answer: null,
    usage: { inputTokens: 100, outputTokens: 30, thinkingTokens: 0 },
    durationMs: 0,
    blocked: "refusal",
  });
  const error = await anthropic.generateText(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("blocked");
  expect(error.usage?.outputTokens).toBe(30);
});

test("anthropic: a truncated JSON answer is rejected even when its JSON is complete", async () => {
  const { anthropic } = provider([json({ ...MESSAGE, stop_reason: "max_tokens" })]);
  const error = await anthropic.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("invalid_answer");
  expect(error.usage?.outputTokens).toBe(30);
});

test("anthropic: malformed JSON and empty answers are invalid answers", async () => {
  const { anthropic } = provider([
    json({ ...MESSAGE, content: [{ type: "text", text: "not JSON" }] }),
    json({ ...MESSAGE, content: [] }),
    json(null),
    json({ ...MESSAGE, content: {} }),
  ]);
  await expect(anthropic.translate(REQUEST)).rejects.toMatchObject({ kind: "invalid_answer" });
  await expect(anthropic.translate(REQUEST)).rejects.toMatchObject({ kind: "invalid_answer" });
  await expect(anthropic.translate(REQUEST)).rejects.toMatchObject({ kind: "invalid_answer" });
  await expect(anthropic.translate(REQUEST)).rejects.toMatchObject({ kind: "invalid_answer" });
});

test("anthropic: rate limits honor Retry-After and overloads retry with jitter", async () => {
  const { anthropic, waits, sent } = provider([
    json({ error: { message: "Rate limited" } }, 429, { "Retry-After": "2" }),
    json({ error: { message: "Overloaded" } }, 529),
    json(MESSAGE),
  ]);
  expect((await anthropic.translate(REQUEST)).answer).toStrictEqual(ANSWER);
  expect(waits).toStrictEqual([2000, 1000]);
  expect(sent.length).toBe(3);
});

test("anthropic: HTTP date retry waits and long waits stop retrying", async () => {
  const { anthropic, waits } = provider([
    json({}, 503, { "Retry-After": "Wed, 04 Nov 2026 00:00:03 GMT" }),
    json(MESSAGE),
    json({}, 429, { "Retry-After": "90" }),
  ]);
  await anthropic.translate(REQUEST);
  const error = await anthropic.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(waits).toStrictEqual([3000]);
  expect(error.kind).toBe("rate_limited");
  expect(error.retryAfterMs).toBe(90_000);
});

test("anthropic: auth errors never retry or disclose keys", async () => {
  const { anthropic, sent } = provider([json({ error: { message: `Invalid key: ${KEY}` } }, 401)]);
  const error = await anthropic.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("auth");
  expect(error.message.includes(KEY)).toBe(false);
  expect(error.message).toContain("[redacted]");
  expect(sent.length).toBe(1);
});

test("anthropic: network errors retry and redact credentials", async () => {
  const { anthropic, sent } = provider([new Error(KEY), new Error(KEY)], { maxAttempts: 2 });
  const error = await anthropic.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("network");
  expect(error.message.includes(KEY)).toBe(false);
  expect(sent.length).toBe(2);
});

test("anthropic: redirects are refused before forwarding credentials", async () => {
  const { anthropic, sent } = provider([
    new Response(null, { status: 307, headers: { Location: "https://other.example" } }),
  ]);
  await expect(anthropic.listModels()).rejects.toMatchObject({ kind: "invalid_request" });
  expect(sent.length).toBe(1);
});

test("anthropic: lists every page, ignoring retired models and duplicate IDs", async () => {
  const { anthropic, sent } = provider([
    json({
      data: [{ id: "claude-haiku-5-5" }, { id: "claude-old", lifecycle: "retired" }],
      has_more: true,
      last_id: "claude-old",
    }),
    json({ data: [{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }], has_more: false }),
  ]);
  expect(await anthropic.listModels()).toStrictEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  expect(sent[1].url).toContain("after_id=claude-old");
});

test("anthropic: pre-cancelled requests and invalid model names never reach the API", async () => {
  const { anthropic, sent } = provider([]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    anthropic.translate({ ...REQUEST, signal: controller.signal }),
  ).rejects.toMatchObject({ kind: "network" });
  await expect(anthropic.translate({ ...REQUEST, model: "../messages" })).rejects.toMatchObject({
    kind: "invalid_request",
  });
  expect(sent.length).toBe(0);
});

test("anthropic: cancelling during a retry wait does not send another request", async () => {
  const controller = new AbortController();
  const { anthropic, sent } = provider([json({}, 429)], {
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
  });
  await expect(
    anthropic.translate({ ...REQUEST, signal: controller.signal }),
  ).rejects.toMatchObject({ kind: "network" });
  expect(sent.length).toBe(1);
});

test("anthropic: an in-flight cancellation stops without retries", async () => {
  const controller = new AbortController();
  let calls = 0;
  const anthropic = createAnthropicProvider({
    apiKey: KEY,
    fetch: (_input, init) => {
      calls++;
      controller.abort();
      return Promise.reject(init?.signal?.reason);
    },
  });
  const error = await anthropic
    .translate({ ...REQUEST, signal: controller.signal })
    .catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("network");
  expect(error.message).toContain("cancelled");
  expect(calls).toBe(1);
});

test("anthropic: timeouts retry up to the attempt limit", async () => {
  let calls = 0;
  const anthropic = createAnthropicProvider({
    apiKey: KEY,
    timeoutMs: 1,
    maxAttempts: 2,
    sleep: () => Promise.resolve(),
    fetch: (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  const error = await anthropic.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("network");
  expect(calls).toBe(2);
});
