// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertMatch, assertRejects } from "@quaso/runtime/assert";
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser } from "./test_helpers.ts";
import { PASSWORD, projectService, signUp } from "./testing/people.ts";

const DAY = 24 * 60 * 60 * 1000;

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await assertRejects(() => promise, ServiceError);
  assertEquals(error.code, code, error.message);
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
  assertEquals(asked.volunteerRequest, {
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
  assertEquals(
    requests.members.map((member) => [member.displayName, member.role]),
    [["Ada", "none"]],
  );
  // The team lists her too, while she waits.
  assertEquals(
    (await service.listMembers(admin, {})).members.map((m) => m.displayName),
    ["Admin", "Ada"],
  );

  const approved = await service.reviewVolunteer(admin, {
    userId: ada.user.id,
    approve: true,
    languages: ["fr"],
  });
  assertEquals([approved.role, approved.languages], ["contributor", ["fr"]]);
  assertEquals(approved.volunteerRequest?.status, "approved");
  assertEquals((await service.listVolunteerRequests(admin, {})).members, []);
  await rejectsWith(
    service.reviewVolunteer(admin, { userId: ada.user.id, approve: true }),
    "not_found",
  );
  // A request answered with a role on the Team page counts as approved too.
  const bea = await signUp(instance, "bea@example.com", "Bea");
  await service.requestVolunteer(bea.actor, { languages: ["de"], message: "" });
  await service.updateMember(admin, { id: bea.user.id, languages: ["de"] });
  assertEquals(
    (await service.listVolunteerRequests(admin, {})).members.map((m) => m.displayName),
    ["Bea"],
    "still waiting: languages alone don't answer",
  );
  const member = await service.updateMember(admin, { id: bea.user.id, role: "contributor" });
  assertEquals([member.role, member.volunteerRequest?.status], ["contributor", "approved"]);
  // Members don't ask to volunteer.
  await rejectsWith(
    service.requestVolunteer(ada.actor, { languages: ["de"], message: "More" }),
    "forbidden",
  );

  const activity = await service.getActivity(ANONYMOUS, {});
  assertEquals(activity.items[0].type, "review");
  assertEquals(activity.items[0].summary, "Volunteer approved: Ada, as contributor (fr)");
  assertEquals(activity.items[0].actor.name, "Admin");
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
  assertEquals([account.role, account.volunteerRequest?.status], ["none", "pending"]);
});

test("team: an approval defaults to the languages asked for; a rejection can ask again", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const bob = await signUp(instance, "bob@example.com", "Bob");
  await service.requestVolunteer(bob.actor, { languages: ["de"], message: "" });
  const rejected = await service.reviewVolunteer(admin, { userId: bob.user.id, approve: false });
  assertEquals([rejected.role, rejected.volunteerRequest?.status], ["none", "rejected"]);
  // The activity feed is public: a refusal isn't in it (design §8).
  assertEquals(
    (await service.getActivity(ANONYMOUS, {})).items.map((i) => i.type),
    ["upload"],
  );
  await service.requestVolunteer(bob.actor, { languages: ["de", "fr"], message: "Please" });
  const approved = await service.reviewVolunteer(admin, {
    userId: bob.user.id,
    approve: true,
    role: "manager",
  });
  assertEquals([approved.role, approved.languages], ["manager", ["de", "fr"]]);
  const all = await signUp(instance, "cy@example.com", "Cy");
  await service.requestVolunteer(all.actor, { languages: ["de"], message: "" });
  const unlimited = await service.reviewVolunteer(admin, {
    userId: all.user.id,
    approve: true,
    languages: null,
  });
  assertEquals(unlimited.languages, null);
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
  assertEquals([member.role, member.languages, member.contributions], ["manager", ["de"], 0]);
  assertEquals(
    (await service.updateMember(admin, { id: ada.user.id, languages: null })).languages,
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
  assertEquals(await service.removeMember(ada.actor, { id: otherId }), { ok: true });
  const [row] = instance.sql.query(
    "SELECT role, languages, deleted_at FROM users WHERE id = ?",
    otherId,
  );
  assertEquals(row, { role: "none", languages: null, deleted_at: null });
  assertEquals(
    (await service.listMembers(ada.actor, {})).members.map((m) => [m.displayName, m.role]),
    [
      ["Ada", "administrator"],
      ["Admin", "manager"],
    ],
  );
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
  assertMatch(invite.url!, /^https:\/\/translate\.example\.com\/signup\?invite=[\w-]{43}$/);
  assertEquals(invite.expiresAt, clock.now + 7 * DAY);
  assertEquals([invite.role, invite.languages, invite.usedAt], ["manager", ["fr"], null]);
  assertEquals(invite.createdBy.name, "Admin");
  const token = new URL(invite.url!).searchParams.get("invite")!;
  assertEquals(
    instance.sql.query("SELECT token_hash FROM invites")[0],
    { token_hash: sha256Hex(token) },
    "stored hashed",
  );
  assertEquals(await service.checkInvite(ANONYMOUS, { token }), {
    valid: true,
    role: "manager",
    languages: ["fr"],
  });
  const listed = await service.listInvites(admin, {});
  assertEquals(
    listed.invites.map((i) => [i.id, i.url]),
    [[invite.id, undefined]],
  );

  const ada = await signUp(instance, "ada@example.com", "Ada", { invite: token });
  assertEquals([ada.user.role, ada.user.languages], ["manager", ["fr"]]);
  assertEquals(await service.checkInvite(ANONYMOUS, { token }), {
    valid: false,
    role: null,
    languages: null,
  });
  const used = (await service.listInvites(admin, {})).invites[0];
  assertEquals([used.usedAt, used.usedBy?.name], [clock.now, "Ada"]);
  // Used once only: the whole sign-up fails, so it can be tried again without.
  await rejectsWith(signUp(instance, "bob@example.com", "Bob", { invite: token }), "bad_request");
  assertEquals((await signUp(instance, "bob@example.com", "Bob")).user.role, "none");
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
  assertEquals(await service.revokeInvite(admin, { id: revoked.id }), { ok: true });
  await rejectsWith(service.revokeInvite(admin, { id: 999 }), "not_found");
  assertEquals(
    (await service.checkInvite(ANONYMOUS, { token: tokenOf(revoked.url!) })).valid,
    false,
  );
  assertEquals(
    (await service.listInvites(admin, {})).invites.map((i) => i.id),
    [short.id],
  );
  clock.advance(7 * DAY);
  assertEquals((await service.checkInvite(ANONYMOUS, { token: tokenOf(short.url!) })).valid, false);
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
  assertEquals([octo.created, octo.user.role], [true, "contributor"]);
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
  assertEquals(await valid(mine.url!), false);
  assertEquals(await valid(theirs.url!), true);
  await rejectsWith(
    signUp(instance, "evil@example.com", "Evil", { invite: tokenOf(mine.url!) }),
    "bad_request",
  );
  const listed = (await service.listInvites(admin, {})).invites.map((i) => i.id);
  assertEquals(listed.includes(mine.id), false);
  assertEquals(listed.includes(used.id), true, "a used invite stays listed");

  // Deleting one's account revokes them too, whatever the role.
  await service.updateMember(admin, { id: pat.user.id, role: "manager" });
  assertEquals(await valid(patInvite.url!), false);
  await service.updateMember(admin, { id: pat.user.id, role: "administrator" });
  const later = await invite(pat.actor);
  await service.deleteAccount(pat.actor, { confirm: "delete", password: PASSWORD });
  assertEquals(await valid(later.url!), false);
  assertEquals(await valid(theirs.url!), true);
});
