// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertMatch, assertNotEquals } from "@quaso/runtime/assert";
import type { Actor } from "@quaso/service";
import {
  COOKIE_MAX_AGE,
  insecureLocal,
  readCookie,
  SESSION_COOKIE,
  SessionCookies,
  Signer,
  TOKEN_TTL_MS,
} from "./sessions.ts";

const SESSION_ID = "A".repeat(43);

/** A service that knows one session, and counts the calls. */
function fakeService(valid = new Map([[SESSION_ID, 7]])) {
  const calls: string[] = [];
  return {
    calls,
    resolveSession(_actor: Actor, input: { sessionId: string }) {
      calls.push(input.sessionId);
      const userId = valid.get(input.sessionId);
      return Promise.resolve(userId === undefined ? null : { userId, expiresAt: 0 });
    },
  };
}

function withCookie(setCookie: string): Request {
  const value = setCookie.split(";")[0];
  return new Request("http://quaso.test/api/v1/project", { headers: { Cookie: `a=b; ${value}` } });
}

test("sessions: a signed token names the user for an hour, without asking the service", async () => {
  let now = 1_000_000;
  const service = fakeService();
  const cookies = new SessionCookies({
    secretKey: "k".repeat(32),
    secure: true,
    service,
    now: () => now,
  });
  const setCookie = await cookies.issue(SESSION_ID, 7);
  assertMatch(
    setCookie,
    new RegExp(
      `^${SESSION_COOKIE}=${SESSION_ID}\\.[\\w-]+\\.[\\w-]+; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure$`,
    ),
  );
  assertEquals(await cookies.read(withCookie(setCookie), true), {
    session: { userId: 7, sessionId: SESSION_ID },
    setCookie: null,
  });
  assertEquals(service.calls, []);

  // After an hour the service decides, and the token is renewed.
  now += TOKEN_TTL_MS;
  const renewed = await cookies.read(withCookie(setCookie), true);
  assertEquals(renewed.session, { userId: 7, sessionId: SESSION_ID });
  assertEquals(service.calls, [SESSION_ID]);
  assertNotEquals(renewed.setCookie, setCookie);
  assertEquals(await cookies.read(withCookie(renewed.setCookie!), true), {
    session: { userId: 7, sessionId: SESSION_ID },
    setCookie: null,
  });
});

test("sessions: a session the service no longer knows clears the cookie", async () => {
  let now = 0;
  const valid = new Map([[SESSION_ID, 7]]);
  const service = fakeService(valid);
  const cookies = new SessionCookies({
    secretKey: "k".repeat(32),
    secure: false,
    service,
    now: () => now,
  });
  const setCookie = await cookies.issue(SESSION_ID, 7);
  valid.delete(SESSION_ID);
  // Still trusted for the rest of the hour (design §5.8: revoked within the hour)...
  assertEquals((await cookies.read(withCookie(setCookie), true)).session?.userId, 7);
  now += TOKEN_TTL_MS + 1;
  // ...then gone.
  const read = await cookies.read(withCookie(setCookie), true);
  assertEquals(read.session, null);
  assertEquals(read.setCookie, `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
});

test("sessions: forged, tampered and foreign tokens are checked with the service", async () => {
  const service = fakeService();
  const cookies = new SessionCookies({ secretKey: "k".repeat(32), secure: true, service });
  const other = new SessionCookies({ secretKey: "other".repeat(8), secure: true, service });
  const genuine = (await cookies.issue(SESSION_ID, 7)).split(";")[0].split("=")[1];
  const [id, payload, signature] = genuine.split(".");

  // Another user's ID in the token: the signature fails, and the service says who it is.
  const forgedPayload = btoa(JSON.stringify({ uid: 1, exp: Date.now() + 1e9 }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const forged = await cookies.read(
    withCookie(`${SESSION_COOKIE}=${id}.${forgedPayload}.${signature}`),
  );
  assertEquals(forged.session?.userId, 7);
  assert(forged.setCookie?.startsWith(`${SESSION_COOKIE}=${SESSION_ID}.`));

  // A token signed with another key (SECRET_KEY changed): the session survives.
  const foreign = (await other.issue(SESSION_ID, 7)).split(";")[0];
  assertEquals((await cookies.read(withCookie(foreign))).session?.userId, 7);

  // The signature covers the session ID: a stolen token doesn't fit another session.
  const unknown = await cookies.read(
    withCookie(`${SESSION_COOKIE}=${"B".repeat(43)}.${payload}.${signature}`),
  );
  assertEquals(unknown.session, null);
  assert(unknown.setCookie?.includes("Max-Age=0"));

  // Nonsense clears the cookie without asking; no cookie does nothing.
  const calls = service.calls.length;
  assertEquals((await cookies.read(withCookie(`${SESSION_COOKIE}=garbage`))).session, null);
  assertEquals(service.calls.length, calls);
  assertEquals(await cookies.read(new Request("http://quaso.test/")), {
    session: null,
    setCookie: null,
  });
});

test("sessions: cookies, local addresses, and sealed values", async () => {
  const request = new Request("http://x/", {
    headers: { Cookie: "a=1; quaso_session=v.w.x ; b=2" },
  });
  assertEquals(readCookie(request, SESSION_COOKIE), "v.w.x");
  assertEquals(readCookie(request, "c"), null);
  assert(insecureLocal("http://localhost:8000"));
  assert(insecureLocal("http://127.0.0.1:5173"));
  assert(!insecureLocal("https://localhost"));
  assert(!insecureLocal("http://translate.example.com"));

  const signer = new Signer("secret", "test");
  const sealed = await signer.seal({ a: 1 });
  assertEquals(await signer.open(sealed), { a: 1 });
  assertEquals(await new Signer("secret", "other").open(sealed), null, "per purpose");
  assertEquals(await signer.open(sealed.replace(/^./, "x")), null);
  assertEquals(await signer.open("nonsense"), null);
});
