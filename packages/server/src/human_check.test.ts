// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@quaso/runtime/assert";
import { ServiceError, silentLogger } from "@quaso/service";
import { createHumanCheck, TURNSTILE_VERIFY_URL } from "./human_check.ts";

test("human check: off without Turnstile's keys", async () => {
  await createHumanCheck(null, { log: silentLogger })(undefined, null);
});

test("human check: Turnstile verifies the token with the secret", async () => {
  const forms: { url: string; form: URLSearchParams }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const form = new URLSearchParams(await request.text());
    forms.push({ url: request.url, form });
    return Response.json({ success: form.get("response") === "good" });
  }) as typeof globalThis.fetch;
  const check = createHumanCheck(
    { siteKey: "site", secretKey: "secret" },
    {
      fetch,
      log: silentLogger,
    },
  );
  await check("good", "192.0.2.1");
  assertEquals(forms[0].url, TURNSTILE_VERIFY_URL);
  assertEquals(Object.fromEntries(forms[0].form), {
    secret: "secret",
    response: "good",
    remoteip: "192.0.2.1",
  });
  const failed = await assertRejects(() => check("bad", null), ServiceError);
  assertEquals(failed.code, "bad_request");
  const missing = await assertRejects(() => check(undefined, null), ServiceError);
  assertEquals(missing.message, "Complete the human check first.");
  assertEquals(forms.length, 2, "no request without a token");

  const down = createHumanCheck(
    { siteKey: "s", secretKey: "k" },
    {
      fetch: () => Promise.reject(new TypeError("offline")),
      log: silentLogger,
    },
  );
  assertEquals((await assertRejects(() => down("x", null), ServiceError)).code, "unavailable");
});
