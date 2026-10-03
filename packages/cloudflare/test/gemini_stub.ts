// SPDX-License-Identifier: MIT
/**
 * A fake Gemini API for the tests in workerd. Vitest runs it in Node as the test Worker's
 * outbound service (vitest.config.ts), so the real Gemini provider, with the runtime's own
 * `fetch`, reaches it at `GEMINI_STUB_URL` from the Worker and the Durable Object, exactly
 * as it reaches Google in production. Anything else outbound is refused: the tests are
 * offline.
 *
 * - `GET /v1beta/models` lists `gemini-stub`;
 * - `POST /v1beta/models/{model}:generateContent` answers a translation request (JSON
 *   output) with every string of the prompt as `[Gemini] {english}`, and a text request
 *   (a file's context) with a sentence;
 * - the model `moved` answers a redirect, which the provider must not follow;
 * - a request without the key `GEMINI_STUB_KEY` in `x-goog-api-key` is refused, as Google
 *   refuses an invalid key.
 */

export const GEMINI_STUB_URL = "http://gemini.test";
export const GEMINI_STUB_KEY = "AIza-stub-key";
/** The redirect's target: a request that reaches it is a redirect that was followed. */
const REDIRECT_TARGET = "/followed-a-redirect";

/** What the stub reads of a request (Miniflare's request type, as a structure). */
export interface StubRequest {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export async function geminiStub(request: StubRequest): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== GEMINI_STUB_URL) {
    return new Response(`The tests are offline: no request to ${url.origin}`, { status: 502 });
  }
  if (request.headers.get("x-goog-api-key") !== GEMINI_STUB_KEY) {
    return json(
      {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      },
      400,
    );
  }
  if (url.pathname === REDIRECT_TARGET) {
    return json({ error: { code: 418, message: "A redirect was followed" } }, 418);
  }
  if (request.method === "GET" && url.pathname === "/v1beta/models") {
    return json({
      models: [
        { name: "models/gemini-stub", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-stub", supportedGenerationMethods: ["embedContent"] },
      ],
    });
  }
  const match = /^\/v1beta\/models\/([\w.-]+):generateContent$/.exec(url.pathname);
  if (request.method !== "POST" || match === null) {
    return json({ error: { code: 404, message: `Not found: ${url.pathname}` } }, 404);
  }
  if (match[1] === "moved") {
    return new Response(null, {
      status: 302,
      headers: { Location: `${GEMINI_STUB_URL}${REDIRECT_TARGET}` },
    });
  }
  const body = JSON.parse(await request.text()) as {
    contents: { parts: { text: string }[] }[];
    generationConfig?: { responseMimeType?: string };
  };
  const prompt = body.contents[0].parts[0].text;
  const text =
    body.generationConfig?.responseMimeType === "application/json"
      ? JSON.stringify({ translations: translations(prompt) })
      : "The texts of a game's menus (a context from the Gemini stub).";
  return json({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10 },
    modelVersion: match[1],
  });
}

/** The prompt's strings (its JSON lines with an ID, a key and English), "translated". */
function translations(prompt: string): unknown[] {
  const out: unknown[] = [];
  for (const line of prompt.split("\n")) {
    let item: { id?: unknown; key?: unknown; english?: unknown; forms?: unknown };
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof item?.id !== "string" || typeof item.key !== "string") continue;
    if (typeof item.english === "string") {
      out.push({ id: item.id, text: `[Gemini] ${item.english}` });
    } else if (typeof item.english === "object" && item.english !== null) {
      const other = (item.english as Record<string, string>).other ?? "";
      const forms = Object.keys((item.forms ?? { other: "" }) as Record<string, string>);
      out.push({
        id: item.id,
        forms: Object.fromEntries(forms.map((form) => [form, `[Gemini] ${other}`])),
      });
    }
  }
  return out;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}
