// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createGeminiProvider,
  GEMINI_BASE_URL,
  HARM_CATEGORIES,
  parseRetryAfter,
  safetySettings,
  toGeminiSchema,
} from "./gemini.ts";
import { RESPONSE_SCHEMA } from "./prompt.ts";
import { ProviderError, type ProviderRequest } from "./provider.ts";

const KEY = "AIzaSy-test-key-0123456789";

/** A recorded answer from `testdata/`. */
async function recorded(name: string): Promise<string> {
  return await fs.readFile(new URL(`./testdata/${name}`, import.meta.url), "utf8");
}

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fetch that answers from a script, one answer per call, and records the requests. */
function scripted(answers: (Response | Error | Promise<Response>)[]): {
  fetch: Fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error("No more answers");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

function json(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function provider(answers: (Response | Error)[], extra: { random?: () => number } = {}) {
  const script = scripted(answers);
  const waits: number[] = [];
  const gemini = createGeminiProvider({
    apiKey: KEY,
    fetch: script.fetch,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: extra.random ?? (() => 0.5),
    now: () => Date.UTC(2026, 8, 24, 12),
  });
  return { gemini, sent: script.sent, waits };
}

const REQUEST: ProviderRequest = {
  model: "gemini-flash-latest",
  system: "You are a translator.",
  prompt: "Translate these strings.",
  responseSchema: RESPONSE_SCHEMA,
  safety: "permissive",
};

test("gemini: a normal answer is parsed, with its usage and without its thoughts", async () => {
  const { gemini, sent } = provider([json(await recorded("generate_ok.json"))]);
  const result = await gemini.translate(REQUEST);
  assertEquals(result.answer, {
    translations: [
      { id: "s1", text: "Willkommen zurück, {{name}}!" },
      { id: "s2", forms: { one: "{{count}} Münze", other: "{{count}} Münzen" } },
    ],
  });
  assertEquals(result.usage, { inputTokens: 812, outputTokens: 64, thinkingTokens: 304 });
  assertEquals(result.blocked, undefined);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].url, `${GEMINI_BASE_URL}/v1beta/models/gemini-flash-latest:generateContent`);
  assertEquals(sent[0].method, "POST");
});

test("gemini: the request body has the system instruction, the schema and safety", async () => {
  const { gemini, sent } = provider([json(await recorded("generate_ok.json"))]);
  await gemini.translate(REQUEST);
  const body = sent[0].body as any;
  assertEquals(body.systemInstruction, { parts: [{ text: "You are a translator." }] });
  assertEquals(body.contents, [{ role: "user", parts: [{ text: "Translate these strings." }] }]);
  assertEquals(body.generationConfig.responseMimeType, "application/json");
  assertEquals(body.generationConfig.temperature, 0.2);
  const schema = body.generationConfig.responseSchema;
  assertEquals(schema.type, "OBJECT");
  assertEquals(schema.required, ["translations"]);
  assertEquals(schema.properties.translations.type, "ARRAY");
  assertEquals(schema.properties.translations.items.type, "OBJECT");
  assertEquals(schema.properties.translations.items.properties.id.type, "STRING");
  assertEquals(schema.properties.translations.items.properties.forms.properties.few.type, "STRING");
  assertEquals(schema.properties.translations.items.propertyOrdering, [
    "id",
    "text",
    "forms",
    "referenceNotes",
    "ambiguous",
  ]);
  assertEquals(
    body.safetySettings,
    HARM_CATEGORIES.map((category) => ({
      category,
      threshold: "BLOCK_NONE",
    })),
  );
});

test("gemini: safety settings for each level", () => {
  assertEquals(
    safetySettings("permissive").map((s) => s.threshold),
    ["BLOCK_NONE", "BLOCK_NONE", "BLOCK_NONE", "BLOCK_NONE"],
  );
  assertEquals(
    safetySettings("permissive").map((s) => s.category),
    [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ],
  );
  assertEquals(safetySettings("default"), []);
  assertEquals(
    safetySettings("strict").map((s) => s.threshold),
    new Array(4).fill("BLOCK_LOW_AND_ABOVE"),
  );
});

test("gemini: each safety level reaches the request", async () => {
  for (const safety of ["default", "strict"] as const) {
    const { gemini, sent } = provider([json(await recorded("generate_ok.json"))]);
    await gemini.translate({ ...REQUEST, safety });
    assertEquals((sent[0].body as any).safetySettings, safetySettings(safety));
  }
});

test("gemini: the key is only in the x-goog-api-key header", async () => {
  const { gemini, sent } = provider([
    json(await recorded("generate_ok.json")),
    json(await recorded("models_page2.json")),
  ]);
  await gemini.translate(REQUEST);
  await gemini.listModels();
  for (const request of sent) {
    assertEquals(request.headers.get("x-goog-api-key"), KEY);
    assertFalse(request.url.includes(KEY), request.url);
    assertFalse(JSON.stringify(request.body ?? "").includes(KEY));
    assertEquals(request.headers.get("Authorization"), null);
  }
});

test("gemini: a safety-blocked answer is reported as blocked, with its usage", async () => {
  const { gemini } = provider([json(await recorded("generate_blocked.json"))]);
  const result = await gemini.translate(REQUEST);
  assertEquals(result.blocked, "SAFETY");
  assertEquals(result.answer, null);
  assertEquals(result.usage, { inputTokens: 640, outputTokens: 0, thinkingTokens: 0 });

  const prompt = provider([json(await recorded("generate_prompt_blocked.json"))]);
  const blocked = await prompt.gemini.translate(REQUEST);
  assertEquals(blocked.blocked, "PROHIBITED_CONTENT");
});

test("gemini: an answer cut off at MAX_TOKENS is an invalid answer, with its usage", async () => {
  const { gemini, sent } = provider([json(await recorded("generate_max_tokens.json"))]);
  const error = await assertRejects(() => gemini.translate(REQUEST), ProviderError);
  assertEquals(error.kind, "invalid_answer");
  assertStringIncludes(error.message, "MAX_TOKENS");
  assertEquals(error.usage, { inputTokens: 812, outputTokens: 40, thinkingTokens: 7340 });
  assertEquals(sent.length, 1, "not retried");
});

test("gemini: a 429 with Retry-After is retried after the wait it asks for", async () => {
  const { gemini, sent, waits } = provider([
    json(await recorded("error_429.json"), 429, { "Retry-After": "3" }),
    json(await recorded("generate_ok.json")),
  ]);
  const result = await gemini.translate(REQUEST);
  assertEquals(result.usage.inputTokens, 812);
  assertEquals(sent.length, 2);
  assertEquals(waits, [3000]);
});

test("gemini: without Retry-After, a 429 waits for the answer's retryDelay", async () => {
  const { gemini, waits } = provider([
    json(await recorded("error_429.json"), 429),
    json(await recorded("generate_ok.json")),
  ]);
  await gemini.translate(REQUEST);
  assertEquals(waits, [7000]);
});

test("gemini: a 500 is retried with exponential backoff and full jitter", async () => {
  const { gemini, sent, waits } = provider(
    [
      json(await recorded("error_500.json"), 500),
      json(await recorded("error_500.json"), 503),
      json(await recorded("generate_ok.json")),
    ],
    { random: () => 0.5 },
  );
  const result = await gemini.translate(REQUEST);
  assert(result.answer !== null);
  assertEquals(sent.length, 3);
  // Half of 1 s, then half of 2 s.
  assertEquals(waits, [500, 1000]);
});

test("gemini: network errors are retried; after 4 attempts the error stays", async () => {
  const { gemini, sent, waits } = provider(
    [
      new TypeError("error sending request: connection reset"),
      new TypeError("error sending request: connection reset"),
      json(await recorded("error_500.json"), 502),
      json(await recorded("error_500.json"), 500),
    ],
    { random: () => 1 },
  );
  const error = await assertRejects(() => gemini.translate(REQUEST), ProviderError);
  assertEquals(error.kind, "server");
  assertEquals(error.status, 500);
  assertEquals(sent.length, 4);
  assertEquals(waits, [1000, 2000, 4000]);
});

test("gemini: a network error that survives the retries is a network error", async () => {
  const { gemini } = provider(new Array(4).fill(new TypeError("dns error: no such host")));
  const error = await assertRejects(() => gemini.translate(REQUEST), ProviderError);
  assertEquals(error.kind, "network");
  assertStringIncludes(error.message, "no such host");
});

test("gemini: a 400 is an invalid request, not retried", async () => {
  const { gemini, sent } = provider([json(await recorded("error_400.json"), 400)]);
  const error = await assertRejects(() => gemini.translate(REQUEST), ProviderError);
  assertEquals(error.kind, "invalid_request");
  assertEquals(error.status, 400);
  assertStringIncludes(error.message, "Unknown name");
  assertEquals(sent.length, 1);
});

test("gemini: a redirect isn't followed (not with redirect: error, which workerd refuses)", async () => {
  const modes: (RequestRedirect | undefined)[] = [];
  const answers = [
    new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }),
    // What a browser's fetch gives for a redirect with `manual`.
    Object.defineProperties(new Response(null, { status: 200 }), {
      type: { value: "opaqueredirect" },
      status: { value: 0 },
      ok: { value: false },
    }),
  ];
  const gemini = createGeminiProvider({
    apiKey: KEY,
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      modes.push(init?.redirect);
      return Promise.resolve(answers.shift()!);
    }) as Fetch,
    sleep: () => Promise.resolve(),
  });
  const moved = await assertRejects(() => gemini.translate(REQUEST), ProviderError);
  assertEquals([moved.kind, moved.status], ["invalid_request", 302]);
  assertStringIncludes(moved.message, "redirect (HTTP 302)");
  const opaque = await assertRejects(() => gemini.listModels(), ProviderError);
  assertEquals([opaque.kind, opaque.status], ["invalid_request", null]);
  assertEquals(modes, ["manual", "manual"], "one attempt each, never following");
});

test("gemini: a 403, or an invalid key, is an auth error, not retried", async () => {
  const forbidden = provider([json(await recorded("error_403.json"), 403)]);
  const error = await assertRejects(() => forbidden.gemini.translate(REQUEST), ProviderError);
  assertEquals(error.kind, "auth");
  assertEquals(forbidden.sent.length, 1);
  assertFalse(error.message.includes(KEY));

  const invalid = provider([json(await recorded("error_400_key.json"), 400)]);
  const bad = await assertRejects(() => invalid.gemini.translate(REQUEST), ProviderError);
  assertEquals(bad.kind, "auth");
  assertStringIncludes(bad.message, "API key not valid");
});

test("gemini: a Retry-After longer than a minute ends the retries", async () => {
  const { gemini, sent } = provider([
    json(await recorded("error_429.json"), 429, { "Retry-After": "3600" }),
  ]);
  const error = await assertRejects(() => gemini.translate(REQUEST), ProviderError);
  assertEquals(error.kind, "rate_limited");
  assertEquals(error.retryAfterMs, 3_600_000);
  assertEquals(sent.length, 1);
});

test("gemini: models, from every page, only those that generate content", async () => {
  const { gemini, sent } = provider([
    json(await recorded("models_page1.json")),
    json(await recorded("models_page2.json")),
  ]);
  assertEquals(await gemini.listModels(), [
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-pro",
  ]);
  assertEquals(sent.length, 2);
  assertEquals(new URL(sent[0].url).pathname, "/v1beta/models");
  assertEquals(new URL(sent[0].url).searchParams.get("pageToken"), null);
  assertEquals(
    new URL(sent[1].url).searchParams.get("pageToken"),
    "Chdtb2RlbHMvZ2VtaW5pLTIuNS1mbGFzaA==",
  );
  assertEquals(sent[0].method, "GET");
});

test("gemini: generateText returns the text without thoughts", async () => {
  const answer = {
    candidates: [
      {
        content: {
          parts: [{ text: "Thinking…", thought: true }, { text: " The main menu of a game. " }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 8 },
  };
  const { gemini, sent } = provider([json(JSON.stringify(answer))]);
  const result = await gemini.generateText({
    model: "gemini-flash-latest",
    system: "S",
    prompt: "P",
  });
  assertEquals(result.text, "The main menu of a game.");
  assertEquals(result.usage, { inputTokens: 100, outputTokens: 8, thinkingTokens: 0 });
  assertEquals((sent[0].body as any).generationConfig.responseMimeType, undefined);
});

test("gemini: an answer that isn't JSON is an invalid answer", async () => {
  const answer = {
    candidates: [{ content: { parts: [{ text: "Sure! Here you go:" }] }, finishReason: "STOP" }],
  };
  const { gemini } = provider([json(JSON.stringify(answer))]);
  const error = await assertRejects(() => gemini.translate(REQUEST), ProviderError);
  assertEquals(error.kind, "invalid_answer");
});

test("gemini: model names that aren't names are refused before any request", async () => {
  const { gemini, sent } = provider([]);
  const error = await assertRejects(
    () => gemini.translate({ ...REQUEST, model: "../v1/files?x=" }),
    ProviderError,
  );
  assertEquals(error.kind, "invalid_request");
  assertEquals(sent.length, 0);
});

test("gemini: JSON schemas become Gemini's schema subset", () => {
  assertEquals(
    toGeminiSchema({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "array", items: { type: "string", enum: ["x"] } } },
      required: ["a"],
    }),
    {
      type: "OBJECT",
      properties: { a: { type: "ARRAY", items: { type: "STRING", enum: ["x"] } } },
      required: ["a"],
    },
  );
});

test("gemini: Retry-After as seconds or as an HTTP date", () => {
  const now = Date.UTC(2026, 8, 24, 12);
  assertEquals(parseRetryAfter("5", now), 5000);
  assertEquals(parseRetryAfter(new Date(now + 9000).toUTCString(), now), 9000);
  assertEquals(parseRetryAfter("soon", now), null);
  assertEquals(parseRetryAfter(null, now), null);
});
