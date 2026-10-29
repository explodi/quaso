// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  const error = await promise.catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code, error.message).toStrictEqual(code);
  if (message !== undefined) expect(error.message).toStrictEqual(message);
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
  expect(result.sessionId).toMatch(/^[\w-]{43}$/);
  expect(result.expiresAt).toStrictEqual(instance.clock.now + SESSION_TTL);
  expect(result.user.email).toBe("ada@example.com");
  expect(result.user.role).toBe("none");
  expect(result.user.languages).toBe(null);
  expect(result.user.hasPassword).toBe(true);
  expect(result.user.emailVerified).toBe(false);
  expect(result.user.identities).toStrictEqual([]);
  expect(result.user.volunteerRequest).toBe(null);
  expect(await service.resolveSession(SYSTEM, { sessionId: result.sessionId })).toStrictEqual({
    userId: result.user.id,
    expiresAt: result.expiresAt,
  });
  const [stored] = instance.sql.query<{ id_hash: string; user_agent: string }>(
    "SELECT id_hash, user_agent FROM sessions",
  );
  expect(stored).toStrictEqual({
    id_hash: sha256Hex(result.sessionId),
    user_agent: "Test browser",
  });
  const [user] = instance.sql.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    result.user.id,
  );
  expect(user.password_hash).toMatch(new RegExp(`^pbkdf2-sha256\\$${TEST_ITERATIONS}\\$`));
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
  expect(signedIn.user.id).toStrictEqual(user.id);
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
  expect(row.password_hash).toMatch(new RegExp(`^pbkdf2-sha256\\$${TEST_ITERATIONS * 2}\\$`));
  await stronger.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD });
  const otherKey = createService({
    sql: instance.sql,
    scheduler: instance.scheduler,
    secretKey: "another key",
    passwordIterations: TEST_ITERATIONS * 2,
  });
  expect(
    (await otherKey.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD })).user.id,
  ).toStrictEqual(user.id);
});

test("accounts: sessions slide for 30 days, at most one write an hour, and end", async () => {
  using instance = await peopleService();
  const { service, clock } = instance;
  const { sessionId, user } = await signUp(instance, "ada@example.com");
  const start = clock.now;
  await rejectsWith(service.resolveSession(ANONYMOUS, { sessionId }), "forbidden");
  clock.advance(SESSION_TOUCH_INTERVAL - 1);
  expect((await service.resolveSession(SYSTEM, { sessionId }))?.expiresAt).toStrictEqual(
    start + SESSION_TTL,
  );
  clock.advance(1);
  expect((await service.resolveSession(SYSTEM, { sessionId }))?.expiresAt).toStrictEqual(
    clock.now + SESSION_TTL,
  );
  clock.advance(SESSION_TTL - 1);
  expect((await service.resolveSession(SYSTEM, { sessionId }))?.userId).toStrictEqual(user.id);
  clock.advance(SESSION_TTL);
  expect(await service.resolveSession(SYSTEM, { sessionId })).toBe(null);
  expect(count(instance.sql, "sessions"), "the expired session is gone").toBe(0);
  expect(await service.resolveSession(SYSTEM, { sessionId: "unknown" })).toBe(null);

  const other = await service.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD });
  expect(await service.signOut(ANONYMOUS, { sessionId: other.sessionId })).toStrictEqual({
    ok: true,
  });
  expect(await service.resolveSession(SYSTEM, { sessionId: other.sessionId })).toBe(null);
});

test("accounts: getSession names the signed-in person and whether setup is needed", async () => {
  using instance = await startTestService({ passwordIterations: TEST_ITERATIONS });
  const { service } = instance;
  expect(await service.getSession(ANONYMOUS, {})).toStrictEqual({
    user: null,
    setupRequired: true,
  });
  const admin = addUser(instance.sql, "administrator", null, "Admin");
  expect(await service.getSession(ANONYMOUS, {})).toStrictEqual({
    user: null,
    setupRequired: false,
  });
  const session = await service.getSession(admin, {});
  expect(session.user?.displayName).toBe("Admin");
  expect(session.user?.role).toBe("administrator");
  instance.sql.run("UPDATE users SET deleted_at = 1");
  expect((await service.getSession(admin, {})).user).toBe(null);
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
  expect(token!).toMatch(/^[\w-]{43}$/);
  expect(await service.ensureSetupToken(SYSTEM, {}), "the same one after a restart").toStrictEqual({
    token,
  });
  expect(await service.validateSetupToken(ANONYMOUS, { token: token! })).toStrictEqual({
    ok: true,
  });
  expect(await service.validateSetupToken(ANONYMOUS, { token: "guess" })).toStrictEqual({
    ok: false,
  });

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
  expect(done.user.role).toBe("administrator");
  expect(done.user.email).toBe("owner@example.com");
  expect(loadSettings(instance.ctx).name).toBe("Quaso Quest");
  expect(loadSettings(instance.ctx).sourceLanguage).toBe("en-GB");
  expect(getMeta(instance.sql, SETUP_TOKEN)).toBe(null);
  expect(await service.ensureSetupToken(SYSTEM, {})).toStrictEqual({ token: null });
  expect(await service.validateSetupToken(ANONYMOUS, { token: token! })).toStrictEqual({
    ok: false,
  });
  await rejectsWith(service.completeSetup(ANONYMOUS, { ...request, token: token! }), "forbidden");
  expect((await service.getSession(ANONYMOUS, {})).setupRequired).toBe(false);
  const again = await service.signIn(ANONYMOUS, { email: "owner@example.com", password: PASSWORD });
  expect(again.user.id).toStrictEqual(done.user.id);
});

test("accounts: SETUP_TOKEN replaces the generated token", async () => {
  using instance = await startTestService({ passwordIterations: TEST_ITERATIONS });
  const { service } = instance;
  const generated = (await service.ensureSetupToken(SYSTEM, {})).token!;
  expect(await service.ensureSetupToken(SYSTEM, { token: "operator-chosen-token" })).toStrictEqual({
    token: "operator-chosen-token",
  });
  expect(await service.validateSetupToken(ANONYMOUS, { token: generated })).toStrictEqual({
    ok: false,
  });
  const done = await service.completeSetup(ANONYMOUS, {
    token: "operator-chosen-token",
    email: "owner@example.com",
    password: PASSWORD,
    displayName: "Owner",
    projectName: "Game",
  });
  expect(done.user.role).toBe("administrator");
  expect(loadSettings(instance.ctx).sourceLanguage).toBe("en");
});

test("accounts: the developer account exists only on development instances", async () => {
  using production = await startTestService();
  await rejectsWith(production.service.ensureDevAccount(SYSTEM, {}), "forbidden");
  await rejectsWith(production.service.devSignIn(SYSTEM, {}), "forbidden");

  using dev = await startTestService({ dev: true });
  await rejectsWith(dev.service.devSignIn(ANONYMOUS, {}), "forbidden");
  const account = await dev.service.ensureDevAccount(SYSTEM, {});
  expect([account.email, account.displayName, account.role, account.hasPassword]).toStrictEqual([
    DEV_EMAIL,
    "Developer",
    "administrator",
    false,
  ]);
  expect((await dev.service.ensureDevAccount(SYSTEM, {})).id).toStrictEqual(account.id);
  const session = await dev.service.devSignIn(SYSTEM, { userAgent: "Browser" });
  expect(session.user.id).toStrictEqual(account.id);
  expect(
    (await dev.service.resolveSession(SYSTEM, { sessionId: session.sessionId }))?.userId,
  ).toStrictEqual(account.id);
  expect((await dev.service.getSession(ANONYMOUS, {})).setupRequired).toBe(false);
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
  expect(first.created).toBe(true);
  expect(first.user.email).toBe(null);
  expect(first.user.displayName).toBe("Octo Cat");
  expect(first.user.avatarUrl).toBe("https://example.com/octo.png");
  expect(first.user.identities).toStrictEqual([{ provider: "github", username: "octo" }]);
  assert(first.sessionId);

  const again = await service.signInWithIdentity(SYSTEM, { ...github, username: "octo2" });
  expect([again.created, again.user.id]).toStrictEqual([false, first.user.id]);
  expect(again.user.identities).toStrictEqual([{ provider: "github", username: "octo2" }]);

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
  expect(count(instance.sql, "identities", "provider = 'discord'")).toBe(0);
  const verify = (await service.createEmailToken(SYSTEM, {
    email: "ada@example.com",
    purpose: "verify",
  }))!;
  await service.verifyEmail(ANONYMOUS, { token: verify.token });
  const discord = await service.signInWithIdentity(SYSTEM, adaDiscord);
  expect([discord.created, discord.user.id]).toStrictEqual([false, ada.user.id]);
  expect(discord.user.emailVerified).toBe(true);

  // Linking to the signed-in person, and not to someone else's.
  const linked = await service.signInWithIdentity(SYSTEM, {
    provider: "github",
    subject: "303",
    username: "ada-gh",
    linkToUserId: ada.user.id,
  });
  expect(linked.sessionId).toBe(null);
  expect(linked.user.identities.map((i) => i.provider)).toStrictEqual(["discord", "github"]);
  await rejectsWith(
    service.signInWithIdentity(SYSTEM, { ...github, linkToUserId: ada.user.id }),
    "conflict",
  );

  // Unlinking: never the last way to sign in.
  const octo: Actor = { type: "user", userId: first.user.id };
  await rejectsWith(service.unlinkIdentity(octo, { provider: "github" }), "bad_request");
  await rejectsWith(service.unlinkIdentity(octo, { provider: "discord" }), "not_found");
  const unlinked = await service.unlinkIdentity(ada.actor, { provider: "github" });
  expect(unlinked.identities).toStrictEqual([{ provider: "discord", username: "ada" }]);
  await service.unlinkIdentity(ada.actor, { provider: "discord" });
  expect((await service.getAccount(ada.actor, {})).identities).toStrictEqual([]);
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
  expect(
    await service.createEmailToken(SYSTEM, { email: "nobody@example.com", purpose: "reset" }),
  ).toBe(null);

  const verify = (await service.createEmailToken(SYSTEM, {
    email: "Ada@example.com",
    purpose: "verify",
  }))!;
  expect([verify.userId, verify.email]).toStrictEqual([ada.user.id, "ada@example.com"]);
  expect(verify.expiresAt).toStrictEqual(clock.now + 7 * DAY);
  expect(
    instance.sql.query("SELECT token_hash FROM email_tokens")[0],
    "stored hashed",
  ).toStrictEqual({ token_hash: sha256Hex(verify.token) });
  expect(await service.verifyEmail(ANONYMOUS, { token: verify.token })).toStrictEqual({ ok: true });
  expect((await service.getAccount(ada.actor, {})).emailVerified).toBe(true);
  await rejectsWith(service.verifyEmail(ANONYMOUS, { token: verify.token }), "bad_request");

  // A reset link: an hour; a new password signs out every session, then signs in.
  const reset = (await service.createEmailToken(SYSTEM, {
    email: "ada@example.com",
    purpose: "reset",
  }))!;
  expect(reset.expiresAt).toStrictEqual(clock.now + HOUR);
  await rejectsWith(
    service.resetPassword(ANONYMOUS, { token: reset.token, password: "short" }),
    "validation_failed",
  );
  const after = await service.resetPassword(ANONYMOUS, {
    token: reset.token,
    password: "a brand new password",
  });
  expect(await service.resolveSession(SYSTEM, { sessionId: ada.sessionId })).toBe(null);
  expect(
    (await service.resolveSession(SYSTEM, { sessionId: after.sessionId }))?.userId,
  ).toStrictEqual(ada.user.id);
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
  expect([viaLink.user.id, viaLink.user.emailVerified]).toStrictEqual([bob.user.id, true]);
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
  expect([account.identities, account.emailVerified]).toStrictEqual([[], false]);

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
  expect(count(instance.sql, "identities")).toBe(0);

  // A GitHub account without that address still signs in, to an account of its own.
  const fresh = await service.signInWithIdentity(SYSTEM, { ...owner, email: null });
  expect(fresh.created).toBe(true);
  expect(fresh.user.id).not.toStrictEqual(squatter.user.id);
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
    expect(refused.message).toMatch(/password reset/);
    expect((await service.getAccount(squatter.actor, {})).emailVerified).toBe(false);

    const reset = (await service.createEmailToken(SYSTEM, { email, purpose: "reset" }))!;
    const recovered = await service.resetPassword(ANONYMOUS, {
      token: reset.token,
      password: "the rightful owner's new password",
    });
    expect(recovered.user.emailVerified).toBe(true);
    expect(recovered.user.identities).toStrictEqual([]);
    expect(await service.resolveSession(SYSTEM, { sessionId: squatter.sessionId })).toStrictEqual(
      null,
    );
    await rejectsWith(service.signIn(ANONYMOUS, { email, password: PASSWORD }), "unauthorized");
    const attacker = await service.signInWithIdentity(SYSTEM, {
      provider: "github",
      subject: email,
    });
    expect(attacker.user.id).not.toStrictEqual(recovered.user.id);
    const next = (await service.createEmailToken(SYSTEM, { email, purpose: "signin" }))!;
    expect(
      (await service.signInWithEmailLink(ANONYMOUS, { token: next.token })).user.id,
    ).toStrictEqual(recovered.user.id);
  }
  const owned = await service.signInWithIdentity(SYSTEM, {
    provider: "discord",
    subject: "owned",
    email: "verified@example.com",
    emailVerified: true,
  });
  expect(owned.user.hasPassword).toBe(false);
  const link = (await service.createEmailToken(SYSTEM, {
    email: "verified@example.com",
    purpose: "signin",
  }))!;
  expect(
    (await service.signInWithEmailLink(ANONYMOUS, { token: link.token })).user.id,
  ).toStrictEqual(owned.user.id);
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
  expect(await service.verifyEmail(ANONYMOUS, { token: verify2 })).toStrictEqual({ ok: true });

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
  expect(signedIn.user.id).toStrictEqual(octo.user.id);
});

test("accounts: administrators create reset links for teams without email", async () => {
  using instance = await peopleService();
  const { service, admin, clock } = instance;
  const ada = await signUp(instance, "ada@example.com");
  const base = { userId: ada.user.id, baseUrl: "https://translate.example.com/" };
  await rejectsWith(service.createResetLink(ada.actor, base), "forbidden");
  const link = await service.createResetLink(admin, base);
  expect(link.url).toMatch(/^https:\/\/translate\.example\.com\/reset-password\?token=[\w-]{43}$/);
  expect(link.expiresAt).toStrictEqual(clock.now + 7 * 24 * HOUR);
  clock.advance(6 * 24 * HOUR);
  const token = new URL(link.url).searchParams.get("token")!;
  const signedIn = await service.resetPassword(ANONYMOUS, { token, password: "chosen by ada now" });
  expect(signedIn.user.id).toStrictEqual(ada.user.id);
  expect(await service.resolveSession(SYSTEM, { sessionId: ada.sessionId })).toBe(null);
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
  expect((await service.updateAccount(ada.actor, { displayName: "Ada L." })).displayName).toBe(
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
  expect([moved.email, moved.emailVerified]).toStrictEqual(["new@example.com", false]);

  // A new password signs out every other session.
  const other = await service.signIn(ANONYMOUS, { email: "new@example.com", password: PASSWORD });
  await service.updateAccount(ada.actor, {
    password: "a much better password",
    currentPassword: PASSWORD,
    sessionId: ada.sessionId,
  });
  expect(await service.resolveSession(SYSTEM, { sessionId: other.sessionId })).toBe(null);
  expect(
    (await service.resolveSession(SYSTEM, { sessionId: ada.sessionId }))?.userId,
  ).toStrictEqual(ada.user.id);
  await service.signIn(ANONYMOUS, { email: "new@example.com", password: "a much better password" });

  // An account without a password sets one (and an address) without a current one.
  const octo = await service.signInWithIdentity(SYSTEM, { provider: "github", subject: "7" });
  const octoActor: Actor = { type: "user", userId: octo.user.id };
  const updated = await service.updateAccount(octoActor, {
    email: "octo@example.com",
    password: "octo's new password",
  });
  expect([updated.email, updated.hasPassword]).toStrictEqual(["octo@example.com", true]);
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
  expect(summaries).toStrictEqual([
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
  expect(
    await service.deleteAccount(ada.actor, { confirm: "delete", password: PASSWORD }),
  ).toStrictEqual({
    ok: true,
  });

  const [row] = instance.sql.query(
    `SELECT email, password_hash, display_name, avatar_url, role, languages, deleted_at
     FROM users WHERE id = ?`,
    ada.user.id,
  );
  expect(row).toStrictEqual({
    email: null,
    password_hash: null,
    display_name: "Deleted user",
    avatar_url: null,
    role: "none",
    languages: null,
    deleted_at: instance.clock.now,
  });
  for (const table of ["identities", "sessions", "email_tokens"]) {
    expect(count(instance.sql, table, `user_id = ${ada.user.id}`), table).toBe(0);
  }
  const [suggestion] = instance.sql.query<{ status: string }>(
    "SELECT status FROM suggestions WHERE id = ?",
    pending.id,
  );
  expect(suggestion.status).toBe("withdrawn");
  const detail = await service.getString(ANONYMOUS, {
    id: stringId(instance.sql, "common.json", "quit"),
    language: "de",
  });
  expect(detail.translation?.author.name).toBe("Deleted user");
  expect(detail.translation?.author.avatarUrl).toBe(null);
  await rejectsWith(service.getAccount(ada.actor, {}), "forbidden");
  expect(await service.resolveSession(SYSTEM, { sessionId: ada.sessionId })).toBe(null);
  await rejectsWith(
    service.signIn(ANONYMOUS, { email: "ada@example.com", password: PASSWORD }),
    "unauthorized",
  );
  // The address is free again.
  const again = await signUp(instance, "ada@example.com");
  expect(again.user.id).not.toStrictEqual(ada.user.id);

  // The last administrator can't leave.
  const [owner] = instance.sql.query<{ id: number }>(
    "SELECT id FROM users WHERE role = 'administrator'",
  );
  await rejectsWith(
    service.deleteAccount({ type: "user", userId: owner.id }, { confirm: "delete" }),
    "bad_request",
  );
  expect(Object.keys(ENGLISH).length > 0).toBe(true);
  expect(admin.type).toBe("user");
});
