// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(forms[0].url).toStrictEqual(TURNSTILE_VERIFY_URL);
  expect(Object.fromEntries(forms[0].form)).toStrictEqual({
    secret: "secret",
    response: "good",
    remoteip: "192.0.2.1",
  });
  const failed = await check("bad", null).catch((error: unknown) => error);
  assert(failed instanceof ServiceError);
  expect(failed.code).toBe("bad_request");
  const missing = await check(undefined, null).catch((error: unknown) => error);
  assert(missing instanceof ServiceError);
  expect(missing.message).toBe("Complete the human check first.");
  expect(forms.length, "no request without a token").toBe(2);

  const down = createHumanCheck(
    { siteKey: "s", secretKey: "k" },
    {
      fetch: () => Promise.reject(new TypeError("offline")),
      log: silentLogger,
    },
  );
  await expect(down("x", null)).rejects.toThrow(
    expect.objectContaining({ constructor: ServiceError, code: "unavailable" }),
  );
});
