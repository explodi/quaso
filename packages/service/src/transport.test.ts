// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { test } from "node:test";
import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import type { ApiErrorBody, TranslationInfo } from "@quaso/core";
import { type Actor, ANONYMOUS, type ServiceApi, type ServiceMethod, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import type { Logger } from "./ports.ts";
import { createToken, startTestService, uploadJson } from "./test_helpers.ts";
import {
  ACCEPTED_SERVICE_API_VERSIONS,
  createHttpServiceClient,
  handleServiceRequest,
  type HttpServiceClientOptions,
  INTERNAL_HEADER,
  SAFE_METHODS,
  SERVICE_API_VERSION,
  SERVICE_ERROR_HEADER,
  SERVICE_METHODS,
  ServiceTransportError,
  timingSafeEqual,
} from "./transport.ts";

const TOKEN = "internal-test-token-0123456789abcdef";
const URL_BASE = "https://quaso.test/internal";

// --- Type tests: the allowlist is exactly the interface's methods.
type Listed = (typeof SERVICE_METHODS)[number];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const everyMethodListed: Exact<Listed, ServiceMethod> = true;
const safeMethodsExist: Exact<
  (typeof SAFE_METHODS)[number] & ServiceMethod,
  (typeof SAFE_METHODS)[number]
> = true;

/** A fetch that calls the handler in-process, recording each request. */
function inProcess(
  service: ServiceApi,
  token: string | null = TOKEN,
): { fetch: Fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetchStub: Fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handleServiceRequest(request, service, { token });
  };
  return { fetch: fetchStub, requests };
}

function client(fetchStub: Fetch, extra: Partial<HttpServiceClientOptions> = {}) {
  return createHttpServiceClient({
    url: URL_BASE,
    token: TOKEN,
    fetch: fetchStub,
    sleep: () => Promise.resolve(),
    ...extra,
  });
}

/** Calls the handler directly. */
function post(
  service: ServiceApi,
  path: string,
  body: unknown,
  init: { token?: string | null; auth?: string | null; method?: string } = {},
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const auth = init.auth === undefined ? `Bearer ${TOKEN}` : init.auth;
  if (auth !== null) headers.set("Authorization", auth);
  const method = init.method ?? "POST";
  const request = new Request(`https://quaso.test${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return handleServiceRequest(request, service, {
    token: init.token === undefined ? TOKEN : init.token,
  });
}

/** A service whose every method throws `error`, or answers `answer`. */
function stubService(behaviour: { error?: unknown; answer?: unknown } = {}): {
  service: ServiceApi;
  calls: { method: string; actor: Actor; input: unknown }[];
} {
  const calls: { method: string; actor: Actor; input: unknown }[] = [];
  const service: Partial<Record<ServiceMethod, unknown>> = {};
  for (const method of SERVICE_METHODS) {
    service[method] = (actor: Actor, input: unknown) => {
      calls.push({ method, actor, input });
      return behaviour.error !== undefined
        ? Promise.reject(behaviour.error)
        : Promise.resolve(behaviour.answer ?? { ok: true });
    };
  }
  return { service: service as unknown as ServiceApi, calls };
}

function memoryLogger(): Logger & { lines: { level: string; message: string; fields: unknown }[] } {
  const lines: { level: string; message: string; fields: unknown }[] = [];
  const log = (level: string) => (message: string, fields?: unknown) =>
    void lines.push({ level, message, fields });
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

test("transport: the method lists", () => {
  assert(everyMethodListed && safeMethodsExist);
  assertEquals(new Set(SERVICE_METHODS).size, SERVICE_METHODS.length);
  for (const method of SAFE_METHODS) assert(SERVICE_METHODS.includes(method), method);
  for (const write of ["upload", "importTranslations", "createApiToken", "revokeApiToken"]) {
    assert(!(SAFE_METHODS as readonly string[]).includes(write), write);
  }
  assertEquals(SERVICE_API_VERSION, 1);
  assert(ACCEPTED_SERVICE_API_VERSIONS.includes(SERVICE_API_VERSION));
});

test("transport: the client calls the real service through the handler", async () => {
  using instance = await startTestService();
  const { fetch: fetchStub, requests } = inProcess(instance.service);
  const remote = client(fetchStub);

  const files = {
    "common.json": {
      menu: { play: "Play", quit: "Quit" },
      coins_one: "{{count}} coin",
      coins_other: "{{count}} coins",
    },
  };
  const direct = await startTestService();
  try {
    const viaHttp = await remote.upload(SYSTEM, {
      files: Object.entries(files).map(([path, value]) => ({
        path,
        repoPath: path,
        content: `${JSON.stringify(value, null, 2)}\n`,
      })),
    });
    const local = await uploadJson(direct.service, files);
    assertEquals(viaHttp, JSON.parse(JSON.stringify(local)));

    assertEquals(
      await remote.getProject(ANONYMOUS, {}),
      JSON.parse(JSON.stringify(await direct.service.getProject(ANONYMOUS, {}))),
    );
    const exported = await remote.exportFiles(SYSTEM, {});
    assertEquals(
      exported,
      JSON.parse(JSON.stringify(await direct.service.exportFiles(SYSTEM, {}))),
    );
    assertEquals(await remote.getHealth(SYSTEM, {}), await direct.service.getHealth(SYSTEM, {}));
  } finally {
    direct.close();
  }

  // A key round-trips, and `authenticateToken` can answer null.
  const key = await createToken(instance.service, "read");
  assertEquals(await remote.authenticateToken(SYSTEM, { secret: key.secret }), {
    tokenId: key.id,
    scope: "read",
    name: "read key",
  });
  assertEquals(await remote.authenticateToken(SYSTEM, { secret: "qso_unknown" }), null);

  const request = requests[0];
  assertEquals(request.method, "POST");
  assertEquals(new URL(request.url).pathname, "/internal/v1/upload");
  assertEquals(request.headers.get("Authorization"), `Bearer ${TOKEN}`);
  assertEquals(request.headers.get(INTERNAL_HEADER), "1");
  assertEquals(request.headers.get("Content-Type"), "application/json");
  const sent = await request.json();
  assertEquals(sent.actor, SYSTEM);
  assertEquals(sent.input.files.length, 1);
});

test("transport: service errors round-trip with their code, details and current", async () => {
  const current: TranslationInfo = {
    value: "Graj",
    colour: "blue",
    outdated: false,
    revision: 7,
    updatedAt: "2026-09-24T12:00:00.000Z",
    updatedBy: { type: "user", id: 3, label: "Ada" },
  } as unknown as TranslationInfo;
  const cases = [
    new ServiceError("qa_failed", "Placeholder {{total}} is missing.", {
      details: [{ file: "common.json", key: "a.b", language: "pl", check: "placeholder_missing" }],
    }),
    new ServiceError("conflict", "Someone saved it first.", { current }),
    new ServiceError("conflict", "It was deleted.", { current: null }),
    new ServiceError("forbidden", "No."),
    new ServiceError("llm_unavailable", "Gemini is down."),
  ];
  for (const thrown of cases) {
    const { service, calls } = stubService({ error: thrown });
    const remote = client(inProcess(service).fetch);
    const error = await assertRejects(() => remote.upload(SYSTEM, { files: [] }), ServiceError);
    assert(!(error instanceof ServiceTransportError));
    assertEquals(error.code, thrown.code);
    assertEquals(error.message, thrown.message);
    assertEquals(error.details, thrown.details);
    assertEquals(error.current, thrown.current);
    assertEquals(error.status, thrown.status);
    assertEquals(error.toBody(), thrown.toBody());
    assertEquals(calls.length, 1, "never tried again, even with a 503");
  }

  // Validation errors from the real service carry their paths.
  using instance = await startTestService();
  const remote = client(inProcess(instance.service).fetch);
  const invalid = await assertRejects(
    () => remote.listFiles(ANONYMOUS, { language: "not a tag!" }),
    ServiceError,
  );
  assertEquals(invalid.code, "validation_failed");
  assertEquals(invalid.details?.[0].path, "language");
});

test("transport: an unexpected error becomes an internal error, and is logged", async () => {
  const { service } = stubService({ error: new TypeError("boom") });
  const log = memoryLogger();
  const fetchStub: Fetch = (input, init) =>
    handleServiceRequest(new Request(input, init), service, { token: TOKEN, logger: log });
  const error = await assertRejects(
    () => client(fetchStub).getProject(ANONYMOUS, {}),
    ServiceError,
  );
  assertEquals(error.code, "internal");
  assertEquals(error.message, "Something went wrong in the service.");
  assertEquals(
    log.lines.map((line) => line.message),
    ["The service failed"],
  );
});

test("transport: safe methods are tried again after network errors and 502/503/504", async () => {
  for (const failure of ["network", 502, 503, 504] as const) {
    let calls = 0;
    const waits: number[] = [];
    const { service } = stubService({ answer: { name: "Demo" } });
    const fetchStub: Fetch = (input, init) => {
      calls++;
      if (calls < 3) {
        if (failure === "network") return Promise.reject(new TypeError("connection reset"));
        return Promise.resolve(new Response("Bad gateway", { status: failure }));
      }
      return handleServiceRequest(new Request(input, init), service, { token: TOKEN });
    };
    const remote = client(fetchStub, {
      retryDelayMs: 100,
      random: () => 1,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    assertEquals(await remote.getProject(ANONYMOUS, {}), { name: "Demo" } as never);
    assertEquals(calls, 3, String(failure));
    assertEquals(waits, [100, 200], "exponential backoff");
  }
});

test("transport: backoff has jitter, and gives up after three attempts", async () => {
  let calls = 0;
  const waits: number[] = [];
  const log = memoryLogger();
  const remote = client(
    () => {
      calls++;
      return Promise.reject(new TypeError("offline"));
    },
    {
      retryDelayMs: 100,
      random: () => 0,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      logger: log,
    },
  );
  const error = await assertRejects(
    () => remote.listFiles(ANONYMOUS, { language: "pl" }),
    ServiceTransportError,
  );
  assertEquals(calls, 3);
  assertEquals(waits, [50, 100], "half of the doubled wait, at the least");
  assertEquals(error.failure, "network");
  assertEquals(error.code, "unavailable");
  assertEquals(error.status, 503);
  assertEquals(
    log.lines.map((line) => line.level),
    ["warn", "warn", "error"],
  );
  assertEquals((log.lines[2].fields as { detail: string }).detail, "TypeError: offline");
});

test("transport: writes are never tried again", async () => {
  for (const method of [
    "upload",
    "importTranslations",
    "createApiToken",
    "revokeApiToken",
  ] as const) {
    let calls = 0;
    const remote = client(() => {
      calls++;
      return Promise.resolve(new Response("", { status: 503 }));
    });
    const call = remote[method] as (actor: Actor, input: unknown) => Promise<unknown>;
    const error = await assertRejects(() => call.call(remote, SYSTEM, {}), ServiceTransportError);
    assertEquals(error.failure, "gateway");
    assertEquals(calls, 1, method);
  }
  // Nor are other failures of safe methods, such as a 500 or a wrong token.
  for (const status of [500, 401, 404, 400]) {
    let calls = 0;
    const remote = client(() => {
      calls++;
      return Promise.resolve(
        Response.json({ error: { code: "internal", message: "x" } }, { status }),
      );
    });
    await assertRejects(() => remote.getProject(ANONYMOUS, {}), ServiceTransportError);
    assertEquals(calls, 1, String(status));
  }
});

test("transport: transport failures say what went wrong in the log, not to people", async () => {
  const { service } = stubService();
  const log = memoryLogger();
  const wrongToken = createHttpServiceClient({
    url: URL_BASE + "/",
    token: "not-the-token",
    fetch: inProcess(service).fetch,
    logger: log,
  });
  const error = await assertRejects(() => wrongToken.getHealth(SYSTEM, {}), ServiceTransportError);
  assertEquals(error.failure, "unauthorized");
  assertEquals(error.httpStatus, 401);
  assertEquals(error.status, 503);
  assertEquals(error.toBody(), {
    error: {
      code: "unavailable",
      message: "The service isn't available right now. Try again in a moment.",
    },
  });
  assert(error.detail.includes("SERVICE_TOKEN must be the same"), error.detail);
  assertEquals(log.lines.length, 1);

  const off = client(inProcess(service, null).fetch);
  const offError = await assertRejects(() => off.getHealth(SYSTEM, {}), ServiceTransportError);
  assertEquals(offError.failure, "not_found");

  const garbage = client(() => Promise.resolve(new Response("<html>", { status: 200 })));
  assertEquals(
    (await assertRejects(() => garbage.upload(SYSTEM, { files: [] }), ServiceTransportError))
      .failure,
    "bad_response",
  );
});

test("transport: the handler checks the token first, in constant time", async () => {
  const { service, calls } = stubService();
  const ok = await post(service, "/internal/v1/getProject", { actor: ANONYMOUS, input: {} });
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), { result: { ok: true } });
  assertEquals(ok.headers.get("Cache-Control"), "private, no-store");

  for (const auth of [null, "Bearer wrong", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, "Bearer"]) {
    const refused = await post(service, "/internal/v1/getProject", { actor: ANONYMOUS }, { auth });
    assertEquals(refused.status, 401, String(auth));
    assertEquals((await refused.json()).error.code, "unauthorized");
    assertEquals(refused.headers.get(SERVICE_ERROR_HEADER), null);
  }
  // Even on unknown paths and methods, the token comes first.
  assertEquals((await post(service, "/nope", {}, { auth: null })).status, 401);
  assertEquals(
    (await post(service, "/internal/v1/x", {}, { auth: null, method: "GET" })).status,
    401,
  );
  assertEquals(calls.length, 1);
});

test("transport: the internal API is off without a token", async () => {
  const { service, calls } = stubService();
  for (const token of [null, undefined, ""]) {
    const request = new Request("https://quaso.test/internal/v1/getProject", {
      method: "POST",
      headers: { Authorization: "Bearer " },
      body: JSON.stringify({ actor: ANONYMOUS }),
    });
    const response = await handleServiceRequest(request, service, { token });
    assertEquals(response.status, 404);
    const body: ApiErrorBody = await response.json();
    assertEquals(
      body.error.message,
      "The internal service API is off. Set SERVICE_TOKEN to turn it on.",
    );
  }
  assertEquals(calls.length, 0);
});

test("transport: versions, method names and HTTP methods", async () => {
  const { service, calls } = stubService();
  const body = { actor: SYSTEM, input: {} };
  assertEquals((await post(service, "/internal/v1/getHealth", body)).status, 200);
  assertEquals((await post(service, "/v1/getHealth", body)).status, 200, "any prefix");
  assertEquals((await post(service, "/internal/v1/getHealth/", body)).status, 200);

  const v2 = await post(service, "/internal/v2/getHealth", body);
  assertEquals(v2.status, 404);
  assertEquals(
    (await v2.json()).error.message,
    "This release doesn't speak v2 of the internal service API, only v1.",
  );
  assertEquals((await post(service, "/internal/v0/getHealth", body)).status, 404);
  assertEquals((await post(service, "/internal/getHealth", body)).status, 404);

  for (const name of ["constructor", "toString", "start", "alarm", "nope", "__proto__"]) {
    const response = await post(service, `/internal/v1/${name}`, body);
    assertEquals(response.status, 404, name);
  }
  const get = await post(service, "/internal/v1/getHealth", body, { method: "GET" });
  assertEquals(get.status, 405);
  assertEquals(get.headers.get("Allow"), "POST");
  assertEquals(
    calls.map((call) => call.method),
    ["getHealth", "getHealth", "getHealth"],
  );
});

test("transport: the handler checks the body's shape", async () => {
  const { service, calls } = stubService();
  const path = "/internal/v1/getProject";
  for (const bad of [
    "not json",
    "[]",
    "null",
    '"text"',
    "{}",
    '{"actor":"system"}',
    '{"actor":{},"input":[1]}',
    '{"actor":{},"input":"x"}',
  ]) {
    const response = await post(service, path, bad);
    assertEquals(response.status, 400, bad);
    assertEquals((await response.json()).error.code, "bad_request");
  }
  assertEquals(calls.length, 0);

  // A missing input is an empty object; the service checks the actor itself.
  const response = await post(service, path, { actor: { type: "robot" } });
  assertEquals(response.status, 200);
  assertEquals(calls[0].input, {});
  assertEquals(calls[0].actor, { type: "robot" } as unknown as Actor);

  // The real service refuses an actor it doesn't know.
  using instance = await startTestService();
  const refused = await post(instance.service, path, { actor: { type: "robot" }, input: {} });
  assertEquals(refused.status, 400);
  assertEquals((await refused.json()).error.code, "validation_failed");
  assertEquals(refused.headers.get(SERVICE_ERROR_HEADER), "1");
});

test("transport: bodies over the limit are refused", async () => {
  const { service, calls } = stubService();
  const big = JSON.stringify({
    actor: SYSTEM,
    input: { files: [{ path: "a", content: "x".repeat(2000) }] },
  });
  const request = () =>
    new Request("https://quaso.test/internal/v1/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: big,
    });
  const refused = await handleServiceRequest(request(), service, {
    token: TOKEN,
    maxBodyBytes: 1000,
  });
  assertEquals(refused.status, 413);
  assertEquals((await refused.json()).error.code, "payload_too_large");

  // Without a Content-Length, the stream is cut off at the limit.
  const streamed = new Request("https://quaso.test/internal/v1/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: new Blob([big]).stream(),
  });
  assertEquals(streamed.headers.get("Content-Length"), null);
  const cut = await handleServiceRequest(streamed, service, { token: TOKEN, maxBodyBytes: 1000 });
  assertEquals(cut.status, 413);
  assertEquals(calls.length, 0);
  assertEquals((await handleServiceRequest(request(), service, { token: TOKEN })).status, 200);
});

test("transport: timingSafeEqual", () => {
  assert(timingSafeEqual("secret", "secret"));
  assert(timingSafeEqual("", ""));
  assert(!timingSafeEqual("secret", "secreT"));
  assert(!timingSafeEqual("secret", "secret "));
  assert(!timingSafeEqual("", "secret"));
  assert(!timingSafeEqual("a".repeat(1000), "a".repeat(999)));
  assert(timingSafeEqual("żółć 🎮", "żółć 🎮"));
});

test("transport: each attempt has a timeout", async () => {
  let signal: AbortSignal | null | undefined;
  const remote = client(
    (_input, init) => {
      signal = init?.signal;
      return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
    },
    { retries: 0 },
  );
  const error = await assertRejects(() => remote.getProject(ANONYMOUS, {}), ServiceTransportError);
  assertInstanceOf(signal, AbortSignal);
  assertEquals(error.failure, "network");
  assertEquals(error.detail, "TimeoutError: The operation timed out.");
});
