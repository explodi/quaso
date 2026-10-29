// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser } from "./test_helpers.ts";
import { PASSWORD, projectService, signUp } from "./testing/people.ts";

const DAY = 24 * 60 * 60 * 1000;

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code, error.message).toStrictEqual(code);
  return error;
}

test("team: a volunteer asks, and an administrator approves with language limits (ROLE-1)", async () => {
  using instance = await projectService();
  const { service, admin, clock } = instance;
  const ada = await signUp(instance, "ada@example.com", "Ada");
  await rejectsWith(
    service.requestVolunteer(ANONYMOUS, { languages: ["fr"], message: "" }),
    "unauthorized",
  );
  await rejectsWith(
    service.requestVolunteer(ada.actor, { languages: ["xx-unknown"], message: "Hi" }),
    "bad_request",
  );
  const asked = await service.requestVolunteer(ada.actor, {
    languages: ["fr", "DE"],
    message: " I speak French. ",
  });
  expect(asked.volunteerRequest).toStrictEqual({
    status: "pending",
    languages: ["fr", "de"],
    message: "I speak French.",
    createdAt: clock.now,
  });
  await rejectsWith(
    service.requestVolunteer(ada.actor, { languages: ["fr"], message: "Again" }),
    "conflict",
  );

  await rejectsWith(service.listVolunteerRequests(ada.actor, {}), "forbidden");
  const requests = await service.listVolunteerRequests(admin, {});
  expect(requests.members.map((member) => [member.displayName, member.role])).toStrictEqual([
    ["Ada", "none"],
  ]);
  // The team lists her too, while she waits.
  expect((await service.listMembers(admin, {})).members.map((m) => m.displayName)).toStrictEqual([
    "Admin",
    "Ada",
  ]);

  const approved = await service.reviewVolunteer(admin, {
    userId: ada.user.id,
    approve: true,
    languages: ["fr"],
  });
  expect([approved.role, approved.languages]).toStrictEqual(["contributor", ["fr"]]);
  expect(approved.volunteerRequest?.status).toBe("approved");
  expect((await service.listVolunteerRequests(admin, {})).members).toStrictEqual([]);
  await rejectsWith(
    service.reviewVolunteer(admin, { userId: ada.user.id, approve: true }),
    "not_found",
  );
  // A request answered with a role on the Team page counts as approved too.
  const bea = await signUp(instance, "bea@example.com", "Bea");
  await service.requestVolunteer(bea.actor, { languages: ["de"], message: "" });
  await service.updateMember(admin, { id: bea.user.id, languages: ["de"] });
  expect(
    (await service.listVolunteerRequests(admin, {})).members.map((m) => m.displayName),
    "still waiting: languages alone don't answer",
  ).toStrictEqual(["Bea"]);
  const member = await service.updateMember(admin, { id: bea.user.id, role: "contributor" });
  expect([member.role, member.volunteerRequest?.status]).toStrictEqual(["contributor", "approved"]);
  // Members don't ask to volunteer.
  await rejectsWith(
    service.requestVolunteer(ada.actor, { languages: ["de"], message: "More" }),
    "forbidden",
  );

  const activity = await service.getActivity(ANONYMOUS, {});
  expect(activity.items[0].type).toBe("review");
  expect(activity.items[0].summary).toBe("Volunteer approved: Ada, as contributor (fr)");
  expect(activity.items[0].actor.name).toBe("Admin");
});

test("team: default volunteer grants refuse languages removed after the request", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const ada = await signUp(instance, "ada@example.com", "Ada");
  await service.requestVolunteer(ada.actor, { languages: ["de"], message: "" });
  await service.removeLanguage(admin, { tag: "de" });
  await rejectsWith(
    service.reviewVolunteer(admin, { userId: ada.user.id, approve: true }),
    "bad_request",
  );
  const account = await service.getAccount(ada.actor, {});
  expect([account.role, account.volunteerRequest?.status]).toStrictEqual(["none", "pending"]);
});

test("team: an approval defaults to the languages asked for; a rejection can ask again", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const bob = await signUp(instance, "bob@example.com", "Bob");
  await service.requestVolunteer(bob.actor, { languages: ["de"], message: "" });
  const rejected = await service.reviewVolunteer(admin, { userId: bob.user.id, approve: false });
  expect([rejected.role, rejected.volunteerRequest?.status]).toStrictEqual(["none", "rejected"]);
  // The activity feed is public: a refusal isn't in it (design §8).
  expect((await service.getActivity(ANONYMOUS, {})).items.map((i) => i.type)).toStrictEqual([
    "upload",
  ]);
  await service.requestVolunteer(bob.actor, { languages: ["de", "fr"], message: "Please" });
  const approved = await service.reviewVolunteer(admin, {
    userId: bob.user.id,
    approve: true,
    role: "manager",
  });
  expect([approved.role, approved.languages]).toStrictEqual(["manager", ["de", "fr"]]);
  const all = await signUp(instance, "cy@example.com", "Cy");
  await service.requestVolunteer(all.actor, { languages: ["de"], message: "" });
  const unlimited = await service.reviewVolunteer(admin, {
    userId: all.user.id,
    approve: true,
    languages: null,
  });
  expect(unlimited.languages).toBe(null);
});

test("team: roles and languages change; the last administrator stays", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const ada = await signUp(instance, "ada@example.com", "Ada");
  const member = await service.updateMember(admin, {
    id: ada.user.id,
    role: "manager",
    languages: ["de"],
  });
  expect([member.role, member.languages, member.contributions]).toStrictEqual([
    "manager",
    ["de"],
    0,
  ]);
  expect((await service.updateMember(admin, { id: ada.user.id, languages: null })).languages).toBe(
    null,
  );
  await rejectsWith(
    service.updateMember(ada.actor, { id: ada.user.id, role: "administrator" }),
    "forbidden",
  );
  await rejectsWith(service.updateMember(admin, { id: 999, role: "manager" }), "not_found");

  // The only administrator can't step down; with two, one can.
  const adminId = admin.type === "user" ? admin.userId : 0;
  await rejectsWith(service.updateMember(admin, { id: adminId, role: "manager" }), "bad_request");
  await rejectsWith(service.removeMember(admin, { id: adminId }), "bad_request");
  await service.updateMember(admin, { id: ada.user.id, role: "administrator" });
  await service.updateMember(admin, { id: adminId, role: "manager" });

  // Removing a member takes the role away; the account stays.
  const other = addUser(instance.sql, "contributor", ["fr"], "Other");
  const otherId = other.type === "user" ? other.userId : 0;
  expect(await service.removeMember(ada.actor, { id: otherId })).toStrictEqual({ ok: true });
  const [row] = instance.sql.query(
    "SELECT role, languages, deleted_at FROM users WHERE id = ?",
    otherId,
  );
  expect(row).toStrictEqual({ role: "none", languages: null, deleted_at: null });
  expect(
    (await service.listMembers(ada.actor, {})).members.map((m) => [m.displayName, m.role]),
  ).toStrictEqual([
    ["Ada", "administrator"],
    ["Admin", "manager"],
  ]);
});

test("team: invite links give their role and languages to one new account", async () => {
  using instance = await projectService();
  const { service, admin, clock } = instance;
  await rejectsWith(
    service.createInvite(ANONYMOUS, { role: "contributor", baseUrl: "https://t.example.com" }),
    "unauthorized",
  );
  const invite = await service.createInvite(admin, {
    role: "manager",
    languages: ["fr"],
    baseUrl: "https://translate.example.com/",
  });
  expect(invite.url!).toMatch(/^https:\/\/translate\.example\.com\/signup\?invite=[\w-]{43}$/);
  expect(invite.expiresAt).toStrictEqual(clock.now + 7 * DAY);
  expect([invite.role, invite.languages, invite.usedAt]).toStrictEqual(["manager", ["fr"], null]);
  expect(invite.createdBy.name).toBe("Admin");
  const token = new URL(invite.url!).searchParams.get("invite")!;
  expect(instance.sql.query("SELECT token_hash FROM invites")[0], "stored hashed").toStrictEqual({
    token_hash: sha256Hex(token),
  });
  expect(await service.checkInvite(ANONYMOUS, { token })).toStrictEqual({
    valid: true,
    role: "manager",
    languages: ["fr"],
  });
  const listed = await service.listInvites(admin, {});
  expect(listed.invites.map((i) => [i.id, i.url])).toStrictEqual([[invite.id, undefined]]);

  const ada = await signUp(instance, "ada@example.com", "Ada", { invite: token });
  expect([ada.user.role, ada.user.languages]).toStrictEqual(["manager", ["fr"]]);
  expect(await service.checkInvite(ANONYMOUS, { token })).toStrictEqual({
    valid: false,
    role: null,
    languages: null,
  });
  const used = (await service.listInvites(admin, {})).invites[0];
  expect([used.usedAt, used.usedBy?.name]).toStrictEqual([clock.now, "Ada"]);
  // Used once only: the whole sign-up fails, so it can be tried again without.
  await rejectsWith(signUp(instance, "bob@example.com", "Bob", { invite: token }), "bad_request");
  expect((await signUp(instance, "bob@example.com", "Bob")).user.role).toBe("none");
});

test("team: invites expire and can be revoked", async () => {
  using instance = await projectService();
  const { service, admin, clock } = instance;
  const short = await service.createInvite(admin, {
    role: "contributor",
    baseUrl: "https://t.example.com",
  });
  const revoked = await service.createInvite(admin, {
    role: "administrator",
    baseUrl: "https://t.example.com",
  });
  const tokenOf = (url: string) => new URL(url).searchParams.get("invite")!;
  expect(await service.revokeInvite(admin, { id: revoked.id })).toStrictEqual({ ok: true });
  await rejectsWith(service.revokeInvite(admin, { id: 999 }), "not_found");
  expect((await service.checkInvite(ANONYMOUS, { token: tokenOf(revoked.url!) })).valid).toBe(
    false,
  );
  expect((await service.listInvites(admin, {})).invites.map((i) => i.id)).toStrictEqual([short.id]);
  clock.advance(7 * DAY);
  expect((await service.checkInvite(ANONYMOUS, { token: tokenOf(short.url!) })).valid).toBe(false);
  await rejectsWith(
    signUp(instance, "late@example.com", "Late", { invite: tokenOf(short.url!) }),
    "bad_request",
  );
  // GitHub and Discord sign-ups take invites too.
  const fresh = await service.createInvite(admin, { role: "contributor", baseUrl: "https://t" });
  const octo = await service.signInWithIdentity(SYSTEM, {
    provider: "github",
    subject: "42",
    invite: tokenOf(fresh.url!),
  });
  expect([octo.created, octo.user.role]).toStrictEqual([true, "contributor"]);
});

test("team: an administrator's unused invites stop working when they stop being one", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const tokenOf = (url: string) => new URL(url).searchParams.get("invite")!;
  const valid = async (url: string) =>
    (await service.checkInvite(ANONYMOUS, { token: tokenOf(url) })).valid;
  const invite = (by: typeof admin, role: "administrator" | "contributor" = "administrator") =>
    service.createInvite(by, { role, baseUrl: "https://t.example.com" });

  const mallory = await signUp(instance, "mallory@example.com", "Mallory");
  const pat = await signUp(instance, "pat@example.com", "Pat");
  for (const person of [mallory, pat]) {
    await service.updateMember(admin, { id: person.user.id, role: "administrator" });
  }
  const [mine, used, theirs] = [
    await invite(mallory.actor),
    await invite(mallory.actor),
    await invite(admin),
  ];
  const patInvite = await invite(pat.actor, "contributor");
  await signUp(instance, "new@example.com", "New", { invite: tokenOf(used.url!) });

  // Removed from the team (or made a manager): their invites go, and nobody else's.
  await service.removeMember(admin, { id: mallory.user.id });
  expect(await valid(mine.url!)).toBe(false);
  expect(await valid(theirs.url!)).toBe(true);
  await rejectsWith(
    signUp(instance, "evil@example.com", "Evil", { invite: tokenOf(mine.url!) }),
    "bad_request",
  );
  const listed = (await service.listInvites(admin, {})).invites.map((i) => i.id);
  expect(listed.includes(mine.id)).toBe(false);
  expect(listed.includes(used.id), "a used invite stays listed").toBe(true);

  // Deleting one's account revokes them too, whatever the role.
  await service.updateMember(admin, { id: pat.user.id, role: "manager" });
  expect(await valid(patInvite.url!)).toBe(false);
  await service.updateMember(admin, { id: pat.user.id, role: "administrator" });
  const later = await invite(pat.actor);
  await service.deleteAccount(pat.actor, { confirm: "delete", password: PASSWORD });
  expect(await valid(later.url!)).toBe(false);
  expect(await valid(theirs.url!)).toBe(true);
});
