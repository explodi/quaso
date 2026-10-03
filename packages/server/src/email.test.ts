// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "@quaso/runtime/assert";
import { ServiceError, silentLogger } from "@quaso/service";
import { createEmailSender, emailLink, escapeHtml, linkEmail } from "./email.ts";

/** A fetch that records requests and answers with `status`. */
function recordingFetch(status = 200, body = '{"id":"1"}') {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: await request.json() });
    return new Response(body, { status });
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

const MESSAGE = { to: "ada@example.com", subject: "Hi", text: "Text", html: "<p>Text</p>" };

test("email: Resend gets a bearer key and its JSON", async () => {
  const { requests, fetch } = recordingFetch();
  const sender = createEmailSender(
    { provider: "resend", apiKey: "re_key", from: "Quaso <quaso@example.com>" },
    { fetch, log: silentLogger },
  )!;
  await sender.send(MESSAGE);
  assertEquals(requests[0].url, "https://api.resend.com/emails");
  assertEquals(requests[0].headers.get("Authorization"), "Bearer re_key");
  assertEquals(requests[0].body, {
    from: "Quaso <quaso@example.com>",
    to: ["ada@example.com"],
    subject: "Hi",
    text: "Text",
    html: "<p>Text</p>",
  });
});

test("email: Postmark gets its server token and its JSON", async () => {
  const { requests, fetch } = recordingFetch();
  const sender = createEmailSender(
    { provider: "postmark", apiKey: "pm_key", from: "quaso@example.com" },
    { fetch, log: silentLogger },
  )!;
  await sender.send(MESSAGE);
  assertEquals(requests[0].url, "https://api.postmarkapp.com/email");
  assertEquals(requests[0].headers.get("X-Postmark-Server-Token"), "pm_key");
  assertEquals(requests[0].body, {
    From: "quaso@example.com",
    To: "ada@example.com",
    Subject: "Hi",
    TextBody: "Text",
    HtmlBody: "<p>Text</p>",
    MessageStream: "outbound",
  });
});

test("email: a refusal or a network error is `unavailable`; no provider, no sender", async () => {
  const { fetch } = recordingFetch(422);
  const sender = createEmailSender(
    { provider: "resend", apiKey: "k", from: "q@example.com" },
    { fetch, log: silentLogger },
  )!;
  const error = await assertRejects(() => sender.send(MESSAGE), ServiceError);
  assertEquals(error.code, "unavailable");
  const offline = createEmailSender(
    { provider: "resend", apiKey: "k", from: "q@example.com" },
    { fetch: () => Promise.reject(new TypeError("offline")), log: silentLogger },
  )!;
  assertEquals(
    (await assertRejects(() => offline.send(MESSAGE), ServiceError)).code,
    "unavailable",
  );
  assertEquals(createEmailSender(null, { log: silentLogger }), null);
});

test("email: links go to the website's pages on PUBLIC_URL, in text and escaped HTML", () => {
  assertEquals(
    emailLink("https://t.example.com/", "reset", "a-b_c"),
    "https://t.example.com/reset-password?token=a-b_c",
  );
  assertEquals(
    emailLink("https://t.example.com", "verify", "x"),
    "https://t.example.com/verify-email?token=x",
  );
  assertEquals(
    emailLink("https://t.example.com", "signin", "x"),
    "https://t.example.com/signin/link?token=x",
  );
  const message = linkEmail("signin", {
    to: "ada@example.com",
    publicUrl: "https://t.example.com",
    token: "tok",
    projectName: "Quest <Deluxe>",
  });
  assertEquals(message.subject, "Your sign-in link (Quest <Deluxe>)");
  assertStringIncludes(message.text, "https://t.example.com/signin/link?token=tok");
  assertStringIncludes(message.html, "Quest &lt;Deluxe&gt;");
  assertStringIncludes(message.html, 'href="https://t.example.com/signin/link?token=tok"');
  assertEquals(
    escapeHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});

const CLOUDFLARE_EMAIL = {
  provider: "cloudflare" as const,
  accountId: "0123456789abcdef0123456789abcdef",
  apiKey: "cf_token",
  from: "quaso@example.com",
};

test("email: Cloudflare gets an account endpoint, bearer token and recipient", async () => {
  const { requests, fetch } = recordingFetch(
    200,
    JSON.stringify({
      success: true,
      result: { delivered: [MESSAGE.to], queued: [] },
    }),
  );
  await createEmailSender(CLOUDFLARE_EMAIL, { fetch, log: silentLogger })!.send(MESSAGE);
  assertEquals(
    requests[0].url,
    "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/email/sending/send",
  );
  assertEquals(requests[0].headers.get("Authorization"), "Bearer cf_token");
  assertEquals(requests[0].body, { from: "quaso@example.com", ...MESSAGE });
});

test("email: Cloudflare accepts queued delivery", async () => {
  const { fetch } = recordingFetch(
    200,
    JSON.stringify({
      success: true,
      result: { delivered: [], queued: [MESSAGE.to] },
    }),
  );
  await createEmailSender(CLOUDFLARE_EMAIL, { fetch, log: silentLogger })!.send(MESSAGE);
});

test("email: Cloudflare permanent bounces are unavailable", async () => {
  const { fetch } = recordingFetch(
    200,
    JSON.stringify({
      success: true,
      result: { delivered: [], queued: [], permanent_bounces: [MESSAGE.to] },
    }),
  );
  const sender = createEmailSender(CLOUDFLARE_EMAIL, { fetch, log: silentLogger })!;
  assertEquals((await assertRejects(() => sender.send(MESSAGE), ServiceError)).code, "unavailable");
});

test("email: Cloudflare application errors are unavailable even with HTTP 200", async () => {
  const { fetch } = recordingFetch(200, '{"success":false,"errors":[{"message":"refused"}]}');
  const sender = createEmailSender(CLOUDFLARE_EMAIL, { fetch, log: silentLogger })!;
  assertEquals((await assertRejects(() => sender.send(MESSAGE), ServiceError)).code, "unavailable");
});

test("email: Cloudflare invalid JSON is unavailable", async () => {
  const { fetch } = recordingFetch(200, "invalid");
  const sender = createEmailSender(CLOUDFLARE_EMAIL, { fetch, log: silentLogger })!;
  assertEquals((await assertRejects(() => sender.send(MESSAGE), ServiceError)).code, "unavailable");
});

test("email: provider responses containing addresses and keys are not logged", async () => {
  const entries: unknown[] = [];
  const { fetch } = recordingFetch(422, MESSAGE.to + CLOUDFLARE_EMAIL.apiKey);
  const sender = createEmailSender(CLOUDFLARE_EMAIL, {
    fetch,
    log: {
      ...silentLogger,
      error: (...args) => {
        entries.push(args);
      },
    },
  })!;
  await assertRejects(() => sender.send(MESSAGE), ServiceError);
  assertEquals(JSON.stringify(entries).includes(MESSAGE.to), false);
  assertEquals(JSON.stringify(entries).includes(CLOUDFLARE_EMAIL.apiKey), false);
});
