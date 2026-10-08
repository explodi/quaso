// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { sha256Hex } from "@quaso/core";
import { DEV_EMAIL, SETUP_TOKEN } from "./accounts.ts";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { getMeta } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { loadSettings } from "./settings.ts";
import { createService } from "./service.ts";
import { SESSION_TOUCH_INTERVAL, SESSION_TTL } from "./sessions.ts";
import { addUser, count, startTestService, stringId, write } from "./test_helpers.ts";
import {
  ENGLISH,
  PASSWORD,
  peopleService,
  projectService,
  signUp,
  TEST_ITERATIONS,
} from "./testing/people.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: string) {
  const error = await assertRejects(() => promise, ServiceError);
  assertEquals(error.code, code, error.message);
  if (message !== undefined) assertEquals(error.message, message);
  return error;
}

test("accounts: sign-up makes an account without a role and signs it in", async () => {
  using instance = await peopleService();
  const { service } = instance;
  const result = await service.signUp(ANONYMOUS, {
    email: "Ada@Example.com",
    password: PASSWORD,
    displayName: "Ada",
    userAgent: "Test browser",
  });
  assertMatch(result.sessionId, /^[\w-]{43}$/);
  assertEquals(result.expiresAt, instance.clock.now + SESSION_TTL);
  assertEquals(result.user.email, "ada@example.com");
  assertEquals(result.user.role, "none");
  assertEquals(result.user.languages, null);
  assertEquals(result.user.hasPassword, true);
  assertEquals(result.user.emailVerified, false);
  assertEquals(result.user.identities, []);
  assertEquals(result.user.volunteerRequest, null);
  assertEquals(await service.resolveSession(SYSTEM, { sessionId: result.sessionId }), {
    userId: result.user.id,
    expiresAt: result.expiresAt,
  });
  const [stored] = instance.sql.query<{ id_hash: string; user_agent: string }>(
    "SELECT id_hash, user_agent FROM sessions",
  );
  assertEquals(stored, { id_hash: sha256Hex(result.sessionId), user_agent: "Test browser" });
  const [user] = instance.sql.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    result.user.id,
  );
  assertMatch(user.password_hash, new RegExp(`^pbkdf2-sha256\\$${TEST_ITERATIONS}\\$`));
  assert(!user.password_hash.includes(PASSWORD));

  await rejectsWith(
    service.signUp(ANONYMOUS, { email: "ADA@example.com", password: PASSWORD, displayName: "A" }),
    "conflict",
  );
  await rejectsWith(
    service.signUp(ANONYMOUS, { email: "bob@example.com", password: "short", displayName: "B" }),
    "validation_failed",
  );
});

test("accounts: sign-in with the email address (any case) and the password", async () => {
  using instance = await peopleService();
  const { service } = instance;
  const { user } = await signUp(instance, "ada@example.com");
  const signedIn = await service.signIn(ANONYMOUS, {
    email: "ADA@example.com",
    password: PASSWORD,
  });
  assertEquals(signedIn.user.id, user.id);
  const wrong = "The email address or the password is wrong.";
  await rejectsWith(
    service.signIn(ANONYMOUS, { email: "ada@example.com", password: "not the password" }),
    "unauthorized",
    wrong,
  );
  await rejectsWith(
    service.signIn(ANONYMOUS, { email: "nobody@example.com", password: PASSWORD }),
    "unauthorized",
    wrong,
  );
  // An account without a password (the developer, GitHub, Discord) can't sign in with one.
  addUser(instance.sql, "manager", null, "No password");
  instance.sql.run(
    "UPDATE users SET email = 'nopassword@example.com' WHERE display_name = 'No password'",
  );
  await rejectsWith(
    service.signIn(ANONYMOUS, { email: "nopassword@example.com", password: PASSWORD }),
    "unauthorized",
    wrong,
  );
});

test("accounts: a sign-in rehashes a password stored with fewer iterations", async () => {
  using instance = await peopleService();
  const { user } = await signUp(instance, "ada@example.com");
  const stronger = createService({
    sql: instance.sql,
    scheduler: instance.scheduler,
    secretKey: "test",
    clock: instance.clock.clock,
    passwordIterations: TEST_ITERATIONS * 2,
  });
  await stronger.start();
  await stronger.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD });
  const [row] = instance.sql.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    user.id,
  );
  assertMatch(row.password_hash, new RegExp(`^pbkdf2-sha256\\$${TEST_ITERATIONS * 2}\\$`));
  await stronger.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD });
  const otherKey = createService({
    sql: instance.sql,
    scheduler: instance.scheduler,
    secretKey: "another key",
    passwordIterations: TEST_ITERATIONS * 2,
  });
  assertEquals(
    (await otherKey.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD })).user.id,
    user.id,
  );
});

test("accounts: sessions slide for 30 days, at most one write an hour, and end", async () => {
  using instance = await peopleService();
  const { service, clock } = instance;
  const { sessionId, user } = await signUp(instance, "ada@example.com");
  const start = clock.now;
  await rejectsWith(service.resolveSession(ANONYMOUS, { sessionId }), "forbidden");
  clock.advance(SESSION_TOUCH_INTERVAL - 1);
  assertEquals(
    (await service.resolveSession(SYSTEM, { sessionId }))?.expiresAt,
    start + SESSION_TTL,
  );
  clock.advance(1);
  assertEquals(
    (await service.resolveSession(SYSTEM, { sessionId }))?.expiresAt,
    clock.now + SESSION_TTL,
  );
  clock.advance(SESSION_TTL - 1);
  assertEquals((await service.resolveSession(SYSTEM, { sessionId }))?.userId, user.id);
  clock.advance(SESSION_TTL);
  assertEquals(await service.resolveSession(SYSTEM, { sessionId }), null);
  assertEquals(count(instance.sql, "sessions"), 0, "the expired session is gone");
  assertEquals(await service.resolveSession(SYSTEM, { sessionId: "unknown" }), null);

  const other = await service.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD });
  assertEquals(await service.signOut(ANONYMOUS, { sessionId: other.sessionId }), { ok: true });
  assertEquals(await service.resolveSession(SYSTEM, { sessionId: other.sessionId }), null);
});

test("accounts: getSession names the signed-in person and whether setup is needed", async () => {
  using instance = await startTestService({ passwordIterations: TEST_ITERATIONS });
  const { service } = instance;
  assertEquals(await service.getSession(ANONYMOUS, {}), { user: null, setupRequired: true });
  const admin = addUser(instance.sql, "administrator", null, "Admin");
  assertEquals(await service.getSession(ANONYMOUS, {}), { user: null, setupRequired: false });
  const session = await service.getSession(admin, {});
  assertEquals(session.user?.displayName, "Admin");
  assertEquals(session.user?.role, "administrator");
  instance.sql.run("UPDATE users SET deleted_at = 1");
  assertEquals((await service.getSession(admin, {})).user, null);
});

test("accounts: the setup token is made once, kept until setup, and then refused", async () => {
  using instance = await startTestService({ passwordIterations: TEST_ITERATIONS });
  const { service } = instance;
  await rejectsWith(
    service.signUp(ANONYMOUS, { email: "ada@example.com", password: PASSWORD, displayName: "A" }),
    "setup_required",
  );
  await rejectsWith(service.ensureSetupToken(ANONYMOUS, {}), "forbidden");
  const { token } = await service.ensureSetupToken(SYSTEM, {});
  assertMatch(token!, /^[\w-]{43}$/);
  assertEquals(
    await service.ensureSetupToken(SYSTEM, {}),
    { token },
    "the same one after a restart",
  );
  assertEquals(await service.validateSetupToken(ANONYMOUS, { token: token! }), { ok: true });
  assertEquals(await service.validateSetupToken(ANONYMOUS, { token: "guess" }), { ok: false });

  const request = {
    token: "wrong",
    email: "owner@example.com",
    password: PASSWORD,
    displayName: "Owner",
    projectName: "Quaso Quest",
    sourceLanguage: "en-GB",
  };
  await rejectsWith(service.completeSetup(ANONYMOUS, request), "forbidden");
  const done = await service.completeSetup(ANONYMOUS, { ...request, token: token! });
  assertEquals(done.user.role, "administrator");
  assertEquals(done.user.email, "owner@example.com");
  assertEquals(loadSettings(instance.ctx).name, "Quaso Quest");
  assertEquals(loadSettings(instance.ctx).sourceLanguage, "en-GB");
  assertEquals(getMeta(instance.sql, SETUP_TOKEN), null);
  assertEquals(await service.ensureSetupToken(SYSTEM, {}), { token: null });
  assertEquals(await service.validateSetupToken(ANONYMOUS, { token: token! }), { ok: false });
  await rejectsWith(service.completeSetup(ANONYMOUS, { ...request, token: token! }), "forbidden");
  assertEquals((await service.getSession(ANONYMOUS, {})).setupRequired, false);
  const again = await service.signIn(ANONYMOUS, { email: "owner@example.com", password: PASSWORD });
  assertEquals(again.user.id, done.user.id);
});

test("accounts: SETUP_TOKEN replaces the generated token", async () => {
  using instance = await startTestService({ passwordIterations: TEST_ITERATIONS });
  const { service } = instance;
  const generated = (await service.ensureSetupToken(SYSTEM, {})).token!;
  assertEquals(await service.ensureSetupToken(SYSTEM, { token: "operator-chosen-token" }), {
    token: "operator-chosen-token",
  });
  assertEquals(await service.validateSetupToken(ANONYMOUS, { token: generated }), { ok: false });
  const done = await service.completeSetup(ANONYMOUS, {
    token: "operator-chosen-token",
    email: "owner@example.com",
    password: PASSWORD,
    displayName: "Owner",
    projectName: "Game",
  });
  assertEquals(done.user.role, "administrator");
  assertEquals(loadSettings(instance.ctx).sourceLanguage, "en");
});

test("accounts: the developer account exists only on development instances", async () => {
  using production = await startTestService();
  await rejectsWith(production.service.ensureDevAccount(SYSTEM, {}), "forbidden");
  await rejectsWith(production.service.devSignIn(SYSTEM, {}), "forbidden");

  using dev = await startTestService({ dev: true });
  await rejectsWith(dev.service.devSignIn(ANONYMOUS, {}), "forbidden");
  const account = await dev.service.ensureDevAccount(SYSTEM, {});
  assertEquals(
    [account.email, account.displayName, account.role, account.hasPassword],
    [DEV_EMAIL, "Developer", "administrator", false],
  );
  assertEquals((await dev.service.ensureDevAccount(SYSTEM, {})).id, account.id);
  const session = await dev.service.devSignIn(SYSTEM, { userAgent: "Browser" });
  assertEquals(session.user.id, account.id);
  assertEquals(
    (await dev.service.resolveSession(SYSTEM, { sessionId: session.sessionId }))?.userId,
    account.id,
  );
  assertEquals((await dev.service.getSession(ANONYMOUS, {})).setupRequired, false);
});

test("accounts: GitHub and Discord sign in, create, link by verified email, and unlink", async () => {
  using instance = await peopleService();
  const { service } = instance;
  const github = { provider: "github" as const, subject: "101", username: "octo" };
  await rejectsWith(service.signInWithIdentity(ANONYMOUS, github), "forbidden");

  // A new account: an unverified address isn't taken.
  const first = await service.signInWithIdentity(SYSTEM, {
    ...github,
    email: "octo@example.com",
    emailVerified: false,
    displayName: "Octo Cat",
    avatarUrl: "https://example.com/octo.png",
  });
  assertEquals(first.created, true);
  assertEquals(first.user.email, null);
  assertEquals(first.user.displayName, "Octo Cat");
  assertEquals(first.user.avatarUrl, "https://example.com/octo.png");
  assertEquals(first.user.identities, [{ provider: "github", username: "octo" }]);
  assert(first.sessionId);

  const again = await service.signInWithIdentity(SYSTEM, { ...github, username: "octo2" });
  assertEquals([again.created, again.user.id], [false, first.user.id]);
  assertEquals(again.user.identities, [{ provider: "github", username: "octo2" }]);

  // A verified address links to the account that has it, once that account verified it too.
  const ada = await signUp(instance, "ada@example.com");
  const adaDiscord = {
    provider: "discord" as const,
    subject: "202",
    username: "ada",
    email: "ADA@example.com",
    emailVerified: true,
  };
  // Unverified, the account could be anyone's (a pre-account hijack): no link, no account.
  await rejectsWith(service.signInWithIdentity(SYSTEM, adaDiscord), "conflict");
  assertEquals(count(instance.sql, "identities", "provider = 'discord'"), 0);
  const verify = (await service.createEmailToken(SYSTEM, {
    email: "ada@example.com",
    purpose: "verify",
  }))!;
  await service.verifyEmail(ANONYMOUS, { token: verify.token });
  const discord = await service.signInWithIdentity(SYSTEM, adaDiscord);
  assertEquals([discord.created, discord.user.id], [false, ada.user.id]);
  assertEquals(discord.user.emailVerified, true);

  // Linking to the signed-in person, and not to someone else's.
  const linked = await service.signInWithIdentity(SYSTEM, {
    provider: "github",
    subject: "303",
    username: "ada-gh",
    linkToUserId: ada.user.id,
  });
  assertEquals(linked.sessionId, null);
  assertEquals(
    linked.user.identities.map((i) => i.provider),
    ["discord", "github"],
  );
  await rejectsWith(
    service.signInWithIdentity(SYSTEM, { ...github, linkToUserId: ada.user.id }),
    "conflict",
  );

  // Unlinking: never the last way to sign in.
  const octo: Actor = { type: "user", userId: first.user.id };
  await rejectsWith(service.unlinkIdentity(octo, { provider: "github" }), "bad_request");
  await rejectsWith(service.unlinkIdentity(octo, { provider: "discord" }), "not_found");
  const unlinked = await service.unlinkIdentity(ada.actor, { provider: "github" });
  assertEquals(unlinked.identities, [{ provider: "discord", username: "ada" }]);
  await service.unlinkIdentity(ada.actor, { provider: "discord" });
  assertEquals((await service.getAccount(ada.actor, {})).identities, []);
});

test("accounts: no new account through GitHub while setup is required", async () => {
  using instance = await startTestService();
  await rejectsWith(
    instance.service.signInWithIdentity(SYSTEM, { provider: "github", subject: "1" }),
    "setup_required",
  );
});

test("accounts: links by email verify, reset and sign in, once each, and expire", async () => {
  using instance = await peopleService();
  const { service, clock } = instance;
  const ada = await signUp(instance, "ada@example.com");
  await rejectsWith(
    service.createEmailToken(ANONYMOUS, { email: "ada@example.com", purpose: "reset" }),
    "forbidden",
  );
  assertEquals(
    await service.createEmailToken(SYSTEM, { email: "nobody@example.com", purpose: "reset" }),
    null,
  );

  const verify = (await service.createEmailToken(SYSTEM, {
    email: "Ada@example.com",
    purpose: "verify",
  }))!;
  assertEquals([verify.userId, verify.email], [ada.user.id, "ada@example.com"]);
  assertEquals(verify.expiresAt, clock.now + 7 * DAY);
  assertEquals(
    instance.sql.query("SELECT token_hash FROM email_tokens")[0],
    { token_hash: sha256Hex(verify.token) },
    "stored hashed",
  );
  assertEquals(await service.verifyEmail(ANONYMOUS, { token: verify.token }), { ok: true });
  assertEquals((await service.getAccount(ada.actor, {})).emailVerified, true);
  await rejectsWith(service.verifyEmail(ANONYMOUS, { token: verify.token }), "bad_request");

  // A reset link: an hour; a new password signs out every session, then signs in.
  const reset = (await service.createEmailToken(SYSTEM, {
    email: "ada@example.com",
    purpose: "reset",
  }))!;
  assertEquals(reset.expiresAt, clock.now + HOUR);
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token: reset.token, password: "short" }),
    "validation_failed",
  );
  const after = await service.resetPassword(ANONYMOUS, {
    token: reset.token,
    password: "a brand new password",
  });
  assertEquals(await service.resolveSession(SYSTEM, { sessionId: ada.sessionId }), null);
  assertEquals(
    (await service.resolveSession(SYSTEM, { sessionId: after.sessionId }))?.userId,
    ada.user.id,
  );
  await rejectsWith(
    service.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD }),
    "unauthorized",
  );
  await service.signIn(ANONYMOUS, { email: "ada@example.com", password: "a brand new password" });
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token: reset.token, password: "another new password" }),
    "bad_request",
  );

  // A sign-in link for an already verified address; expired after an hour.
  const bob = await signUp(instance, "bob@example.com");
  const bobVerification = (await service.createEmailToken(SYSTEM, {
    email: "bob@example.com",
    purpose: "verify",
  }))!;
  await service.verifyEmail(ANONYMOUS, { token: bobVerification.token });
  const link = (await service.createEmailToken(SYSTEM, {
    email: "bob@example.com",
    purpose: "signin",
  }))!;
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token: link.token, password: PASSWORD }),
    "bad_request",
  );
  const viaLink = await service.signInWithEmailLink(ANONYMOUS, { token: link.token });
  assertEquals([viaLink.user.id, viaLink.user.emailVerified], [bob.user.id, true]);
  const late = (await service.createEmailToken(SYSTEM, {
    email: "bob@example.com",
    purpose: "signin",
  }))!;
  clock.advance(HOUR);
  await rejectsWith(service.signInWithEmailLink(ANONYMOUS, { token: late.token }), "bad_request");

  // A verification link for an address the account no longer has does nothing.
  const old = (await service.createEmailToken(SYSTEM, {
    email: "bob@example.com",
    purpose: "verify",
  }))!;
  await service.updateAccount(bob.actor, {
    email: "robert@example.com",
    currentPassword: PASSWORD,
  });
  await rejectsWith(service.verifyEmail(ANONYMOUS, { token: old.token }), "bad_request");
});

test("accounts: a provider's verified address never links to an unverified account", async () => {
  using instance = await peopleService();
  const { service } = instance;
  const owner = {
    provider: "github" as const,
    subject: "777",
    username: "real-lead",
    email: "lead@game.com",
    emailVerified: true,
  };
  // Someone signs up with the owner's address first, with a password of their own...
  const squatter = await signUp(instance, "lead@game.com");
  // ...and when the owner signs in with GitHub, they don't land in that account.
  await rejectsWith(service.signInWithIdentity(SYSTEM, owner), "conflict");
  const account = await service.getAccount(squatter.actor, {});
  assertEquals([account.identities, account.emailVerified], [[], false]);

  // The same when an account takes someone's address, which needs no verification.
  const other = await signUp(instance, "other@example.com");
  await service.updateAccount(other.actor, {
    email: "boss@game.com",
    currentPassword: PASSWORD,
  });
  await rejectsWith(
    service.signInWithIdentity(SYSTEM, { ...owner, subject: "778", email: "boss@game.com" }),
    "conflict",
  );
  assertEquals(count(instance.sql, "identities"), 0);

  // A GitHub account without that address still signs in, to an account of its own.
  const fresh = await service.signInWithIdentity(SYSTEM, { ...owner, email: null });
  assertEquals(fresh.created, true);
  assertNotEquals(fresh.user.id, squatter.user.id);
});

test("accounts: email-link recovery cannot share an unverified account with its creator", async () => {
  using instance = await peopleService();
  const { service } = instance;
  for (const passwordless of [false, true]) {
    const email = passwordless ? "passwordless@example.com" : "owner@example.com";
    const squatter = await signUp(instance, email);
    await service.signInWithIdentity(SYSTEM, {
      provider: "github",
      subject: email,
      linkToUserId: squatter.user.id,
    });
    if (passwordless) {
      instance.sql.run("UPDATE users SET password_hash = NULL WHERE id = ?", squatter.user.id);
    }
    const link = (await service.createEmailToken(SYSTEM, { email, purpose: "signin" }))!;
    const refused = await rejectsWith(
      service.signInWithEmailLink(ANONYMOUS, { token: link.token }),
      "forbidden",
    );
    assertMatch(refused.message, /password reset/);
    assertEquals((await service.getAccount(squatter.actor, {})).emailVerified, false);

    const reset = (await service.createEmailToken(SYSTEM, { email, purpose: "reset" }))!;
    const recovered = await service.resetPassword(ANONYMOUS, {
      token: reset.token,
      password: "the rightful owner's new password",
    });
    assertEquals(recovered.user.emailVerified, true);
    assertEquals(recovered.user.identities, []);
    assertEquals(await service.resolveSession(SYSTEM, { sessionId: squatter.sessionId }), null);
    await rejectsWith(service.signIn(ANONYMOUS, { email, password: PASSWORD }), "unauthorized");
    const attacker = await service.signInWithIdentity(SYSTEM, {
      provider: "github",
      subject: email,
    });
    assertNotEquals(attacker.user.id, recovered.user.id);
    const next = (await service.createEmailToken(SYSTEM, { email, purpose: "signin" }))!;
    assertEquals(
      (await service.signInWithEmailLink(ANONYMOUS, { token: next.token })).user.id,
      recovered.user.id,
    );
  }
  const owned = await service.signInWithIdentity(SYSTEM, {
    provider: "discord",
    subject: "owned",
    email: "verified@example.com",
    emailVerified: true,
  });
  assertEquals(owned.user.hasPassword, false);
  const link = (await service.createEmailToken(SYSTEM, {
    email: "verified@example.com",
    purpose: "signin",
  }))!;
  assertEquals(
    (await service.signInWithEmailLink(ANONYMOUS, { token: link.token })).user.id,
    owned.user.id,
  );
});

test("accounts: a new address, a new password or a reset voids the links sent before", async () => {
  using instance = await peopleService();
  const { service } = instance;
  const ada = await signUp(instance, "ada@example.com");
  const token = async (purpose: "reset" | "signin" | "verify") =>
    (await service.createEmailToken(SYSTEM, { email: "ada@example.com", purpose }))!.token;

  // A new address: every link sent to the old one.
  const [reset, signin, verify] = [
    await token("reset"),
    await token("signin"),
    await token("verify"),
  ];
  await service.updateAccount(ada.actor, { email: "new@example.com", currentPassword: PASSWORD });
  await rejectsWith(service.signInWithEmailLink(ANONYMOUS, { token: signin }), "bad_request");
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token: reset, password: "attacker's password" }),
    "bad_request",
  );
  await rejectsWith(service.verifyEmail(ANONYMOUS, { token: verify }), "bad_request");
  await service.signIn(ANONYMOUS, { email: "new@example.com", password: PASSWORD });

  // A link sent to an address the account had once doesn't work if the row survived.
  const stale = (await service.createEmailToken(SYSTEM, {
    email: "new@example.com",
    purpose: "signin",
  }))!;
  instance.sql.run("UPDATE users SET email = 'newer@example.com' WHERE id = ?", ada.user.id);
  await rejectsWith(service.signInWithEmailLink(ANONYMOUS, { token: stale.token }), "bad_request");
  instance.sql.run("UPDATE users SET email = 'new@example.com' WHERE id = ?", ada.user.id);

  // A new password: the reset and sign-in links, not the verification link.
  const again = async (purpose: "reset" | "signin" | "verify") =>
    (await service.createEmailToken(SYSTEM, { email: "new@example.com", purpose }))!.token;
  const [reset2, signin2, verify2] = [
    await again("reset"),
    await again("signin"),
    await again("verify"),
  ];
  await service.updateAccount(ada.actor, {
    password: "a much better password",
    currentPassword: PASSWORD,
    sessionId: ada.sessionId,
  });
  await rejectsWith(service.signInWithEmailLink(ANONYMOUS, { token: signin2 }), "bad_request");
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token: reset2, password: "attacker's password" }),
    "bad_request",
  );
  assertEquals(await service.verifyEmail(ANONYMOUS, { token: verify2 }), { ok: true });

  // A reset: the other reset and sign-in links.
  const [first, second, link] = [await again("reset"), await again("reset"), await again("signin")];
  await service.resetPassword(ANONYMOUS, { token: first, password: "chosen after a reset" });
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token: second, password: "attacker's password" }),
    "bad_request",
  );
  await rejectsWith(service.signInWithEmailLink(ANONYMOUS, { token: link }), "bad_request");
  await service.signIn(ANONYMOUS, { email: "new@example.com", password: "chosen after a reset" });

  // An administrator's reset link for an account without an address still works.
  const octo = await service.signInWithIdentity(SYSTEM, { provider: "github", subject: "9" });
  const { url } = await service.createResetLink(instance.admin, {
    userId: octo.user.id,
    baseUrl: "https://translate.example.com",
  });
  const signedIn = await service.resetPassword(ANONYMOUS, {
    token: new URL(url).searchParams.get("token")!,
    password: "octo's first password",
  });
  assertEquals(signedIn.user.id, octo.user.id);
});

test("accounts: administrators create reset links for teams without email", async () => {
  using instance = await peopleService();
  const { service, admin, clock } = instance;
  const ada = await signUp(instance, "ada@example.com");
  const base = { userId: ada.user.id, baseUrl: "https://translate.example.com/" };
  await rejectsWith(service.createResetLink(ada.actor, base), "forbidden");
  const link = await service.createResetLink(admin, base);
  assertMatch(link.url, /^https:\/\/translate\.example\.com\/reset-password\?token=[\w-]{43}$/);
  assertEquals(link.expiresAt, clock.now + 7 * 24 * HOUR);
  clock.advance(6 * 24 * HOUR);
  const token = new URL(link.url).searchParams.get("token")!;
  const signedIn = await service.resetPassword(ANONYMOUS, { token, password: "chosen by ada now" });
  assertEquals(signedIn.user.id, ada.user.id);
  assertEquals(await service.resolveSession(SYSTEM, { sessionId: ada.sessionId }), null);
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token, password: "reused password" }),
    "bad_request",
  );
  const expired = await service.createResetLink(admin, base);
  clock.advance(7 * 24 * HOUR);
  await rejectsWith(
    service.resetPassword(ANONYMOUS, {
      token: new URL(expired.url).searchParams.get("token")!,
      password: "expired password",
    }),
    "bad_request",
  );
  await rejectsWith(service.createResetLink(admin, { ...base, userId: 999 }), "not_found");
});

test("accounts: the account changes its name, email address and password", async () => {
  using instance = await peopleService();
  const { service } = instance;
  const ada = await signUp(instance, "ada@example.com");
  await rejectsWith(service.getAccount(ANONYMOUS, {}), "unauthorized");
  assertEquals(
    (await service.updateAccount(ada.actor, { displayName: "Ada L." })).displayName,
    "Ada L.",
  );

  await rejectsWith(service.updateAccount(ada.actor, { email: "new@example.com" }), "bad_request");
  await rejectsWith(
    service.updateAccount(ada.actor, { email: "new@example.com", currentPassword: "wrong one!" }),
    "forbidden",
  );
  await signUp(instance, "taken@example.com");
  await rejectsWith(
    service.updateAccount(ada.actor, { email: "taken@example.com", currentPassword: PASSWORD }),
    "conflict",
  );
  instance.sql.run("UPDATE users SET email_verified = 1 WHERE id = ?", ada.user.id);
  const moved = await service.updateAccount(ada.actor, {
    email: "New@example.com",
    currentPassword: PASSWORD,
  });
  assertEquals([moved.email, moved.emailVerified], ["new@example.com", false]);

  // A new password signs out every other session.
  const other = await service.signIn(ANONYMOUS, { email: "new@example.com", password: PASSWORD });
  await service.updateAccount(ada.actor, {
    password: "a much better password",
    currentPassword: PASSWORD,
    sessionId: ada.sessionId,
  });
  assertEquals(await service.resolveSession(SYSTEM, { sessionId: other.sessionId }), null);
  assertEquals(
    (await service.resolveSession(SYSTEM, { sessionId: ada.sessionId }))?.userId,
    ada.user.id,
  );
  await service.signIn(ANONYMOUS, { email: "new@example.com", password: "a much better password" });

  // An account without a password sets one (and an address) without a current one.
  const octo = await service.signInWithIdentity(SYSTEM, { provider: "github", subject: "7" });
  const octoActor: Actor = { type: "user", userId: octo.user.id };
  const updated = await service.updateAccount(octoActor, {
    email: "octo@example.com",
    password: "octo's new password",
  });
  assertEquals([updated.email, updated.hasPassword], ["octo@example.com", true]);
  await rejectsWith(service.updateAccount(SYSTEM, { displayName: "System" }), "bad_request");
});

test("accounts: a deleted volunteer's name leaves the activity feed (OPS-3)", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const ada = await signUp(instance, "ada@example.com", "Ada Lovelace");
  const bob = await signUp(instance, "bob@example.com", "Bob");
  for (const person of [ada, bob]) {
    await service.requestVolunteer(person.actor, { languages: ["de"], message: "Hi" });
  }
  await service.reviewVolunteer(admin, { userId: ada.user.id, approve: true });
  await service.reviewVolunteer(admin, { userId: bob.user.id, approve: false });
  // The feed is public: a declined request leaves no row in it.
  assert(!JSON.stringify((await service.getActivity(ANONYMOUS, {})).items).includes("Bob"));
  // Earlier versions wrote one; deletion clears the name from those too.
  instance.sql.run(
    `INSERT INTO activity (type, actor_type, actor_id, summary, detail, created_at)
     VALUES ('review', 'user', 1, 'Volunteer request declined: Bob', ?, 0)`,
    JSON.stringify({ kind: "volunteer", userId: bob.user.id, approved: false }),
  );
  await service.deleteAccount(ada.actor, { confirm: "delete", password: PASSWORD });
  await service.deleteAccount(bob.actor, { confirm: "delete", password: PASSWORD });

  const { items } = await service.getActivity(ANONYMOUS, {});
  const summaries = items
    .filter((item) => item.detail.kind === "volunteer")
    .map((item) => item.summary);
  assertEquals(summaries, [
    "Volunteer request declined: Deleted user",
    "Volunteer approved: Deleted user, as contributor (de)",
  ]);
  assert(!JSON.stringify(items).includes("Ada"), "no trace of the name");
  assert(!JSON.stringify(items).includes("Bob"), "no trace of the name");
});

test("accounts: deleting an account keeps what it wrote, as Deleted user (OPS-3)", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const ada = await signUp(instance, "ada@example.com", "Ada");
  await service.updateMember(admin, { id: ada.user.id, role: "contributor" });
  await service.signInWithIdentity(SYSTEM, {
    provider: "github",
    subject: "9",
    linkToUserId: ada.user.id,
  });
  await service.createEmailToken(SYSTEM, { email: "ada@example.com", purpose: "verify" });
  const play = stringId(instance.sql, "common.json", "play");
  const pending = await service.suggest(ada.actor, {
    id: play,
    language: "de",
    kind: "translation",
    value: "Spielen",
    baseRevision: 0,
  });
  // A saved translation by Ada stays after the deletion.
  write(instance, "common.json", "quit", "de", "Beenden", {
    colour: "blue",
    actor: { type: "user", id: ada.user.id, label: null },
    event: "translation_saved",
  });

  await rejectsWith(service.deleteAccount(ada.actor, { confirm: "delete" }), "bad_request");
  await rejectsWith(
    service.deleteAccount(ada.actor, { confirm: "delete", password: "not it at all" }),
    "forbidden",
  );
  await rejectsWith(
    service.deleteAccount(ada.actor, { confirm: "yes" } as never),
    "validation_failed",
  );
  assertEquals(await service.deleteAccount(ada.actor, { confirm: "delete", password: PASSWORD }), {
    ok: true,
  });

  const [row] = instance.sql.query(
    `SELECT email, password_hash, display_name, avatar_url, role, languages, deleted_at
     FROM users WHERE id = ?`,
    ada.user.id,
  );
  assertEquals(row, {
    email: null,
    password_hash: null,
    display_name: "Deleted user",
    avatar_url: null,
    role: "none",
    languages: null,
    deleted_at: instance.clock.now,
  });
  for (const table of ["identities", "sessions", "email_tokens"]) {
    assertEquals(count(instance.sql, table, `user_id = ${ada.user.id}`), 0, table);
  }
  const [suggestion] = instance.sql.query<{ status: string }>(
    "SELECT status FROM suggestions WHERE id = ?",
    pending.id,
  );
  assertEquals(suggestion.status, "withdrawn");
  const detail = await service.getString(ANONYMOUS, {
    id: stringId(instance.sql, "common.json", "quit"),
    language: "de",
  });
  assertEquals(detail.translation?.author.name, "Deleted user");
  assertEquals(detail.translation?.author.avatarUrl, null);
  await rejectsWith(service.getAccount(ada.actor, {}), "forbidden");
  assertEquals(await service.resolveSession(SYSTEM, { sessionId: ada.sessionId }), null);
  await rejectsWith(
    service.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD }),
    "unauthorized",
  );
  // The address is free again.
  const again = await signUp(instance, "ada@example.com");
  assertNotEquals(again.user.id, ada.user.id);

  // The last administrator can't leave.
  const [owner] = instance.sql.query<{ id: number }>(
    "SELECT id FROM users WHERE role = 'administrator'",
  );
  await rejectsWith(
    service.deleteAccount({ type: "user", userId: owner.id }, { confirm: "delete" }),
    "bad_request",
  );
  assertEquals(Object.keys(ENGLISH).length > 0, true);
  assertEquals(admin.type, "user");
});
