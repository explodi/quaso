// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
import { ServiceError } from "@quaso/service";
import { createAuthenticator } from "./auth.ts";
import { FakeService } from "./testing/fake_service.ts";

function request(authorization?: string): Request {
  return new Request("http://quaso.test/api/v1/export", {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

async function unauthorized(promise: () => Promise<unknown>, message: string): Promise<void> {
  const error = await assertRejects(promise, ServiceError);
  assertEquals(error.code, "unauthorized");
  assertEquals(error.status, 401);
  assertEquals(error.message, message);
}

test("auth: no credentials is anonymous", async () => {
  const auth = createAuthenticator(new FakeService());
  assertEquals(await auth.actorFor(request()), { type: "anonymous" });
});

test("auth: an API key becomes its token actor, checked as the system", async () => {
  const service = new FakeService();
  const { secret, id } = service.addToken("read");
  const auth = createAuthenticator(service);
  assertEquals(await auth.actorFor(request(`Bearer ${secret}`)), { type: "token", tokenId: id });
  assertEquals(await auth.actorFor(request(`bearer   ${secret}`)), { type: "token", tokenId: id });
  assertEquals(service.calls[0].actor, { type: "system" });
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
  assertEquals(service.count("authenticateToken"), 1);
});

test("auth: checks are cached for a minute, so a revoked key stops within a minute", async () => {
  const service = new FakeService();
  const { secret } = service.addToken("upload");
  let now = 1_000_000;
  const auth = createAuthenticator(service, { now: () => now });
  await auth.actorFor(request(`Bearer ${secret}`));
  service.tokens.get(secret)!.revoked = true;
  now += 59_000;
  assertEquals((await auth.actorFor(request(`Bearer ${secret}`))).type, "token");
  assertEquals(service.count("authenticateToken"), 1);
  now += 2_000;
  await unauthorized(
    () => auth.actorFor(request(`Bearer ${secret}`)),
    "This API key is unknown or was revoked.",
  );
  assertEquals(service.count("authenticateToken"), 2);
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
  assertEquals(service.count("authenticateToken"), 3);
  await auth.actorFor(request(`Bearer ${keys[0]}`));
  assertEquals(service.count("authenticateToken"), 4);
});
