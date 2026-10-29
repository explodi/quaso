// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { ServiceError } from "@quaso/service";
import { createAuthenticator } from "./auth.ts";
import { FakeService } from "./testing/fake_service.ts";

function request(authorization?: string): Request {
  return new Request("http://quaso.test/api/v1/export", {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

async function unauthorized(promise: () => Promise<unknown>, message: string): Promise<void> {
  const error = await Promise.try(promise).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("unauthorized");
  expect(error.status).toBe(401);
  expect(error.message).toStrictEqual(message);
}

test("auth: no credentials is anonymous", async () => {
  const auth = createAuthenticator(new FakeService());
  expect(await auth.actorFor(request())).toStrictEqual({ type: "anonymous" });
});

test("auth: an API key becomes its token actor, checked as the system", async () => {
  const service = new FakeService();
  const { secret, id } = service.addToken("read");
  const auth = createAuthenticator(service);
  expect(await auth.actorFor(request(`Bearer ${secret}`))).toStrictEqual({
    type: "token",
    tokenId: id,
  });
  expect(await auth.actorFor(request(`bearer   ${secret}`))).toStrictEqual({
    type: "token",
    tokenId: id,
  });
  expect(service.calls[0].actor).toStrictEqual({ type: "system" });
});

test("auth: malformed, unknown and revoked keys are 401", async () => {
  const service = new FakeService();
  const auth = createAuthenticator(service);
  await unauthorized(
    () => auth.actorFor(request("Basic dXNlcjpwYXNz")),
    "Send the API key as: Authorization: Bearer qso_…",
  );
  await unauthorized(
    () => auth.actorFor(request("Bearer ghp_notours")),
    "API keys start with qso_. Check QUASO_API_KEY.",
  );
  await unauthorized(
    () => auth.actorFor(request("Bearer qso_unknown")),
    "This API key is unknown or was revoked.",
  );
  expect(service.count("authenticateToken")).toBe(1);
});

test("auth: checks are cached for a minute, so a revoked key stops within a minute", async () => {
  const service = new FakeService();
  const { secret } = service.addToken("upload");
  let now = 1_000_000;
  const auth = createAuthenticator(service, { now: () => now });
  await auth.actorFor(request(`Bearer ${secret}`));
  service.tokens.get(secret)!.revoked = true;
  now += 59_000;
  expect((await auth.actorFor(request(`Bearer ${secret}`))).type).toBe("token");
  expect(service.count("authenticateToken")).toBe(1);
  now += 2_000;
  await unauthorized(
    () => auth.actorFor(request(`Bearer ${secret}`)),
    "This API key is unknown or was revoked.",
  );
  expect(service.count("authenticateToken")).toBe(2);
});

test("auth: forget() drops a revoked key at once", async () => {
  const service = new FakeService();
  const { secret, id } = service.addToken("upload");
  const auth = createAuthenticator(service);
  await auth.actorFor(request(`Bearer ${secret}`));
  service.tokens.get(secret)!.revoked = true;
  auth.forget(id);
  await unauthorized(
    () => auth.actorFor(request(`Bearer ${secret}`)),
    "This API key is unknown or was revoked.",
  );
});

test("auth: the cache is bounded", async () => {
  const service = new FakeService();
  const keys = [1, 2, 3].map(() => service.addToken("read").secret);
  const auth = createAuthenticator(service, { maxEntries: 2 });
  for (const key of keys) await auth.actorFor(request(`Bearer ${key}`));
  await auth.actorFor(request(`Bearer ${keys[2]}`));
  expect(service.count("authenticateToken")).toBe(3);
  await auth.actorFor(request(`Bearer ${keys[0]}`));
  expect(service.count("authenticateToken")).toBe(4);
});
