// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
import {
  createGeminiProvider,
  GEMINI_BASE_URL,
  HARM_CATEGORIES,
  lowThinking,
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
  expect(result.answer).toStrictEqual({
    translations: [
      { id: "s1", text: "Willkommen zurück, {{name}}!" },
      { id: "s2", forms: { one: "{{count}} Münze", other: "{{count}} Münzen" } },
    ],
  });
  expect(result.usage).toStrictEqual({ inputTokens: 812, outputTokens: 64, thinkingTokens: 304 });
  expect(result.blocked).toBe(undefined);
  expect(sent.length).toBe(1);
  expect(sent[0].url).toStrictEqual(
    `${GEMINI_BASE_URL}/v1beta/models/gemini-flash-latest:generateContent`,
  );
  expect(sent[0].method).toBe("POST");
});

test("gemini: the request body has the system instruction, the schema and safety", async () => {
  const { gemini, sent } = provider([json(await recorded("generate_ok.json"))]);
  await gemini.translate(REQUEST);
  const body = sent[0].body as any;
  expect(body.systemInstruction).toStrictEqual({ parts: [{ text: "You are a translator." }] });
  expect(body.contents).toStrictEqual([
    { role: "user", parts: [{ text: "Translate these strings." }] },
  ]);
  expect(body.generationConfig.responseMimeType).toBe("application/json");
  expect(body.generationConfig.temperature).toBe(0.2);
  const schema = body.generationConfig.responseSchema;
  expect(schema.type).toBe("OBJECT");
  expect(schema.required).toStrictEqual(["translations"]);
  expect(schema.properties.translations.type).toBe("ARRAY");
  expect(schema.properties.translations.items.type).toBe("OBJECT");
  expect(schema.properties.translations.items.properties.id.type).toBe("STRING");
  expect(schema.properties.translations.items.properties.forms.properties.few.type).toStrictEqual(
    "STRING",
  );
  expect(schema.properties.translations.items.propertyOrdering).toStrictEqual([
    "id",
    "text",
    "forms",
    "referenceNotes",
    "ambiguous",
  ]);
  expect(body.safetySettings).toStrictEqual(
    HARM_CATEGORIES.map((category) => ({
      category,
      threshold: "BLOCK_NONE",
    })),
  );
});

test("gemini: safety settings for each level", () => {
  expect(safetySettings("permissive").map((s) => s.threshold)).toStrictEqual([
    "BLOCK_NONE",
    "BLOCK_NONE",
    "BLOCK_NONE",
    "BLOCK_NONE",
  ]);
  expect(safetySettings("permissive").map((s) => s.category)).toStrictEqual([
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
  ]);
  expect(safetySettings("default")).toStrictEqual([]);
  expect(safetySettings("strict").map((s) => s.threshold)).toStrictEqual(
    new Array(4).fill("BLOCK_LOW_AND_ABOVE"),
  );
});

test("gemini: each safety level reaches the request", async () => {
  for (const safety of ["default", "strict"] as const) {
    const { gemini, sent } = provider([json(await recorded("generate_ok.json"))]);
    await gemini.translate({ ...REQUEST, safety });
    expect((sent[0].body as any).safetySettings).toStrictEqual(safetySettings(safety));
  }
});

test("gemini: a request that doesn't ask for less thinking leaves the model's own", async () => {
  const { gemini, sent } = provider([json(await recorded("generate_ok.json"))]);
  await gemini.translate(REQUEST);
  expect((sent[0].body as any).generationConfig.thinkingConfig).toBe(undefined);
});

test("gemini: low thinking is a level for Gemini 3 and the latest aliases", async () => {
  const { gemini, sent } = provider([
    json(await recorded("generate_ok.json")),
    json(await recorded("generate_ok.json")),
  ]);
  await gemini.translate({ ...REQUEST, model: "gemini-3.8-flash", thinking: "low" });
  await gemini.translate({ ...REQUEST, thinking: "low" });
  expect((sent[0].body as any).generationConfig.thinkingConfig).toStrictEqual({
    thinkingLevel: "low",
  });
  expect((sent[1].body as any).generationConfig.thinkingConfig).toStrictEqual({
    thinkingLevel: "low",
  });
});

test("gemini: low thinking is a token budget for Gemini 2.5, and Pro can't go to none", () => {
  expect(lowThinking("gemini-2.5-flash")).toStrictEqual({ thinkingBudget: 0 });
  expect(lowThinking("gemini-2.5-flash-lite")).toStrictEqual({ thinkingBudget: 0 });
  expect(lowThinking("gemini-2.5-pro")).toStrictEqual({ thinkingBudget: 128 });
});

test("gemini: a model that isn't Gemini gets no thinking settings", () => {
  expect(lowThinking("gemma-3-27b-it")).toBe(undefined);
});

test("gemini: a model that refuses the thinking settings is asked again without them, for good", async () => {
  const refusal = JSON.stringify({
    error: { code: 400, message: "Thinking level is not supported for this model." },
  });
  const { gemini, sent } = provider([
    json(refusal, 400),
    json(await recorded("generate_ok.json")),
    json(await recorded("generate_ok.json")),
  ]);
  await gemini.translate({ ...REQUEST, thinking: "low" });
  await gemini.translate({ ...REQUEST, thinking: "low" });
  expect(sent.length).toBe(3);
  expect((sent[0].body as any).generationConfig.thinkingConfig).toStrictEqual({
    thinkingLevel: "low",
  });
  expect((sent[1].body as any).generationConfig.thinkingConfig).toBe(undefined);
  expect((sent[2].body as any).generationConfig.thinkingConfig).toBe(undefined);
});

test("gemini: a 400 that isn't about thinking isn't asked again", async () => {
  const { gemini, sent } = provider([json(await recorded("error_400.json"), 400)]);
  await expect(gemini.translate({ ...REQUEST, thinking: "low" })).rejects.toThrow(ProviderError);
  expect(sent.length).toBe(1);
});

test("gemini: the key is only in the x-goog-api-key header", async () => {
  const { gemini, sent } = provider([
    json(await recorded("generate_ok.json")),
    json(await recorded("models_page2.json")),
  ]);
  await gemini.translate(REQUEST);
  await gemini.listModels();
  for (const request of sent) {
    expect(request.headers.get("x-goog-api-key")).toStrictEqual(KEY);
    expect(request.url.includes(KEY), request.url).toBeFalsy();
    expect(JSON.stringify(request.body ?? "").includes(KEY)).toBeFalsy();
    expect(request.headers.get("Authorization")).toBe(null);
  }
});

test("gemini: a safety-blocked answer is reported as blocked, with its usage", async () => {
  const { gemini } = provider([json(await recorded("generate_blocked.json"))]);
  const result = await gemini.translate(REQUEST);
  expect(result.blocked).toBe("SAFETY");
  expect(result.answer).toBe(null);
  expect(result.usage).toStrictEqual({ inputTokens: 640, outputTokens: 0, thinkingTokens: 0 });

  const prompt = provider([json(await recorded("generate_prompt_blocked.json"))]);
  const blocked = await prompt.gemini.translate(REQUEST);
  expect(blocked.blocked).toBe("PROHIBITED_CONTENT");
});

test("gemini: an answer cut off at MAX_TOKENS is an invalid answer, with its usage", async () => {
  const { gemini, sent } = provider([json(await recorded("generate_max_tokens.json"))]);
  const error = await gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("invalid_answer");
  expect(error.message).toContain("MAX_TOKENS");
  expect(error.usage).toStrictEqual({ inputTokens: 812, outputTokens: 40, thinkingTokens: 7340 });
  expect(sent.length, "not retried").toBe(1);
});

test("gemini: a 429 with Retry-After is retried after the wait it asks for", async () => {
  const { gemini, sent, waits } = provider([
    json(await recorded("error_429.json"), 429, { "Retry-After": "3" }),
    json(await recorded("generate_ok.json")),
  ]);
  const result = await gemini.translate(REQUEST);
  expect(result.usage.inputTokens).toBe(812);
  expect(sent.length).toBe(2);
  expect(waits).toStrictEqual([3000]);
});

test("gemini: without Retry-After, a 429 waits for the answer's retryDelay", async () => {
  const { gemini, waits } = provider([
    json(await recorded("error_429.json"), 429),
    json(await recorded("generate_ok.json")),
  ]);
  await gemini.translate(REQUEST);
  expect(waits).toStrictEqual([7000]);
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
  expect(sent.length).toBe(3);
  // Half of 1 s, then half of 2 s.
  expect(waits).toStrictEqual([500, 1000]);
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
  const error = await gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("server");
  expect(error.status).toBe(500);
  expect(sent.length).toBe(4);
  expect(waits).toStrictEqual([1000, 2000, 4000]);
});

test("gemini: a network error that survives the retries is a network error", async () => {
  const { gemini } = provider(new Array(4).fill(new TypeError("dns error: no such host")));
  const error = await gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("network");
  expect(error.message).toContain("no such host");
});

test("gemini: a 400 is an invalid request, not retried", async () => {
  const { gemini, sent } = provider([json(await recorded("error_400.json"), 400)]);
  const error = await gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("invalid_request");
  expect(error.status).toBe(400);
  expect(error.message).toContain("Unknown name");
  expect(sent.length).toBe(1);
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
  const moved = await gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(moved instanceof ProviderError);
  expect([moved.kind, moved.status]).toStrictEqual(["invalid_request", 302]);
  expect(moved.message).toContain("redirect (HTTP 302)");
  const opaque = await gemini.listModels().catch((error: unknown) => error);
  assert(opaque instanceof ProviderError);
  expect([opaque.kind, opaque.status]).toStrictEqual(["invalid_request", null]);
  expect(modes, "one attempt each, never following").toStrictEqual(["manual", "manual"]);
});

test("gemini: a 403, or an invalid key, is an auth error, not retried", async () => {
  const forbidden = provider([json(await recorded("error_403.json"), 403)]);
  const error = await forbidden.gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("auth");
  expect(forbidden.sent.length).toBe(1);
  expect(error.message.includes(KEY)).toBeFalsy();

  const invalid = provider([json(await recorded("error_400_key.json"), 400)]);
  const bad = await invalid.gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(bad instanceof ProviderError);
  expect(bad.kind).toBe("auth");
  expect(bad.message).toContain("API key not valid");
});

test("gemini: a Retry-After longer than a minute ends the retries", async () => {
  const { gemini, sent } = provider([
    json(await recorded("error_429.json"), 429, { "Retry-After": "3600" }),
  ]);
  const error = await gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("rate_limited");
  expect(error.retryAfterMs).toBe(3_600_000);
  expect(sent.length).toBe(1);
});

test("gemini: models, from every page, only those that generate content", async () => {
  const { gemini, sent } = provider([
    json(await recorded("models_page1.json")),
    json(await recorded("models_page2.json")),
  ]);
  expect(await gemini.listModels()).toStrictEqual([
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-pro",
  ]);
  expect(sent.length).toBe(2);
  expect(new URL(sent[0].url).pathname).toBe("/v1beta/models");
  expect(new URL(sent[0].url).searchParams.get("pageToken")).toBe(null);
  expect(new URL(sent[1].url).searchParams.get("pageToken")).toStrictEqual(
    "Chdtb2RlbHMvZ2VtaW5pLTIuNS1mbGFzaA==",
  );
  expect(sent[0].method).toBe("GET");
});

test("gemini: models for speech, images, audio and robots aren't offered to translate with", async () => {
  const model = (name: string) => ({
    name: `models/${name}`,
    supportedGenerationMethods: ["generateContent"],
  });
  const { gemini } = provider([
    json(
      JSON.stringify({
        models: [
          model("gemini-3.8-flash"),
          model("gemini-2.5-flash-preview-tts"),
          model("gemini-2.5-flash-image"),
          model("gemini-3-pro-image-preview"),
          model("gemini-2.5-flash-native-audio-preview-09-2025"),
          model("gemini-live-2.5-flash-preview"),
          model("gemini-robotics-er-1.5-preview"),
          model("gemini-2.5-computer-use-preview-10-2025"),
          model("gemini-flash-latest"),
        ],
      }),
    ),
  ]);
  expect(await gemini.listModels()).toStrictEqual(["gemini-3.8-flash", "gemini-flash-latest"]);
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
  expect(result.text).toBe("The main menu of a game.");
  expect(result.usage).toStrictEqual({ inputTokens: 100, outputTokens: 8, thinkingTokens: 0 });
  expect((sent[0].body as any).generationConfig.responseMimeType).toBe(undefined);
});

test("gemini: an answer that isn't JSON is an invalid answer", async () => {
  const answer = {
    candidates: [{ content: { parts: [{ text: "Sure! Here you go:" }] }, finishReason: "STOP" }],
  };
  const { gemini } = provider([json(JSON.stringify(answer))]);
  const error = await gemini.translate(REQUEST).catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("invalid_answer");
});

test("gemini: model names that aren't names are refused before any request", async () => {
  const { gemini, sent } = provider([]);
  const error = await gemini
    .translate({ ...REQUEST, model: "../v1/files?x=" })
    .catch((error: unknown) => error);
  assert(error instanceof ProviderError);
  expect(error.kind).toBe("invalid_request");
  expect(sent.length).toBe(0);
});

test("gemini: JSON schemas become Gemini's schema subset", () => {
  expect(
    toGeminiSchema({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "array", items: { type: "string", enum: ["x"] } } },
      required: ["a"],
    }),
  ).toStrictEqual({
    type: "OBJECT",
    properties: { a: { type: "ARRAY", items: { type: "STRING", enum: ["x"] } } },
    required: ["a"],
  });
});

test("gemini: Retry-After as seconds or as an HTTP date", () => {
  const now = Date.UTC(2026, 8, 24, 12);
  expect(parseRetryAfter("5", now)).toBe(5000);
  expect(parseRetryAfter(new Date(now + 9000).toUTCString(), now)).toBe(9000);
  expect(parseRetryAfter("soon", now)).toBe(null);
  expect(parseRetryAfter(null, now)).toBe(null);
});
