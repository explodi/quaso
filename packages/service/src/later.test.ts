// SPDX-License-Identifier: MIT
import { test } from "node:test";
/** Validation, permission edges, live QA and LLM integration for community features. */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { glossaryFor } from "./glossary.ts";
import { drain, scriptedProvider } from "./jobs/testing.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import { addUser, createToken, startTestService, stringId, uploadJson } from "./test_helpers.ts";

test("later permissions: API keys and deleted accounts cannot publish or vote", async () => {
  using t = await startTestService();
  await t.service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
  await uploadJson(t.service, { "common.json": { title: "Quaso" } }, { languages: ["de"] });
  const id = stringId(t.sql, "common.json", "title");
  const deleted = addUser(t.sql, "administrator");
  assert(deleted.type === "user");
  t.sql.run("UPDATE users SET deleted_at = 1 WHERE id = ?", deleted.userId);
  for (const actor of [
    deleted,
    (await createToken(t.service, "read")).actor,
    (await createToken(t.service, "upload")).actor,
  ]) {
    for (const operation of [
      () => t.service.createGlossaryTerm(actor, { term: "Quaso", kind: "keep" }),
      () => t.service.addComment(actor, { stringId: id, body: "A note" }),
      () => t.service.requestLanguage(actor, { tag: "fr" }),
    ]) {
      assertEquals((await assertRejects(operation, ServiceError)).code, "forbidden");
    }
    assertEquals((await t.service.listComments(actor, { stringId: id })).comments, []);
  }
});

test("glossary: patch validation, matching language, case and StringDetail payload", async () => {
  using t = await startTestService();
  await uploadJson(
    t.service,
    {
      "common.json": { title: "Play Quaso", lower: "play quaso", false: "Replay Quasoline" },
    },
    { languages: ["de", "fr"] },
  );
  await t.service.createGlossaryTerm(SYSTEM, {
    term: "Quaso",
    kind: "keep",
    caseSensitive: true,
    note: "Brand",
  });
  const term = await t.service.createGlossaryTerm(SYSTEM, {
    term: "Play",
    kind: "translate",
    language: "DE",
    translation: "Spielen",
  });
  await t.service.createGlossaryTerm(SYSTEM, {
    term: "Play",
    kind: "translate",
    language: "fr",
    translation: "Jouer",
  });
  assertEquals(
    glossaryFor(t.ctx, "de", ["Play Quaso"]).map((g) => g.term),
    ["Play", "Quaso"],
  );
  assertEquals(glossaryFor(t.ctx, "de", ["Replay Quasoline"]), []);
  assertEquals(
    glossaryFor(t.ctx, "de", ["play quaso"]).map((g) => g.term),
    ["Play"],
  );
  const detail = await t.service.getString(ANONYMOUS, {
    id: stringId(t.sql, "common.json", "title"),
    language: "de",
  });
  assertEquals(
    detail.glossary.map((g) => g.term),
    ["Play", "Quaso"],
  );
  assertEquals((await t.service.listGlossary(ANONYMOUS, { q: "brand" })).terms.length, 1);
  await assertRejects(
    () => t.service.updateGlossaryTerm(SYSTEM, { id: term.id, translation: " " }),
    ServiceError,
  );
  assertEquals(
    (await t.service.listGlossary(ANONYMOUS, { language: "de", q: "play" })).terms[0].translation,
    "Spielen",
  );
  assertEquals(
    (await t.service.updateGlossaryTerm(SYSTEM, { id: term.id, kind: "keep" })).translation,
    null,
  );
});

test("comments: paging, source context, author-only deletion and missing strings", async () => {
  using t = await startTestService();
  await uploadJson(t.service, { "common.json": { title: "Quaso" } }, { languages: ["de", "fr"] });
  const id = stringId(t.sql, "common.json", "title");
  const author = addUser(t.sql, "contributor");
  const other = addUser(t.sql, "contributor");
  const manager = addUser(t.sql, "manager");
  const first = await t.service.addComment(author, {
    stringId: id,
    body: " Typo? ",
    language: "fr",
    sourceIssue: true,
  });
  assertEquals(first.language, null);
  assertEquals(first.body, "Typo?");
  const second = await t.service.addComment(author, {
    stringId: id,
    body: "German wording",
    language: "de",
  });
  const page = await t.service.listComments(ANONYMOUS, { stringId: id, language: "de", limit: 1 });
  assertEquals(page.total, 2);
  assertEquals(page.comments[0].id, second.id);
  assertEquals(
    (await t.service.listComments(ANONYMOUS, { stringId: id, cursor: page.nextCursor!, limit: 1 }))
      .comments[0].id,
    first.id,
  );
  await assertRejects(() => t.service.resolveComment(other, { id: first.id }), ServiceError);
  await t.service.resolveComment(manager, { id: first.id });
  assertEquals(
    (await t.service.listComments(manager, { sourceIssue: true, resolved: false })).comments,
    [],
  );
  await assertRejects(() => t.service.deleteComment(manager, { id: second.id }), ServiceError);
  await t.service.deleteComment(author, { id: second.id });
  await assertRejects(
    () => t.service.addComment(author, { stringId: 999, body: "Ghost" }),
    ServiceError,
  );
  await assertRejects(
    () => t.service.listComments(ANONYMOUS, { stringId: id, cursor: "NaN" }),
    ServiceError,
  );
});

test("language requests: rejection permits a new request and votes are personal", async () => {
  using t = await startTestService();
  await t.service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
  const user = addUser(t.sql, "none");
  const admin = addUser(t.sql, "administrator");
  const request = await t.service.requestLanguage(user, { tag: "iw", message: "Hebrew please" });
  assertEquals(request.tag, "he");
  assertEquals(request.voted, true);
  assertEquals((await t.service.listLanguageRequests(ANONYMOUS, {})).requests[0].voted, false);
  assertEquals(
    (await t.service.reviewLanguageRequest(admin, { id: request.id, action: "reject" })).status,
    "rejected",
  );
  const again = await t.service.requestLanguage(user, { tag: "he" });
  assert(again.id !== request.id);
  await t.service.addLanguage(admin, { tag: "he" });
  assertEquals(
    (await t.service.reviewLanguageRequest(admin, { id: again.id, action: "approve" })).status,
    "approved",
  );
});

test("LLM: glossary context includes only matching target terms and never-translate terms, and can be disabled", async () => {
  const provider = scriptedProvider();
  using t = await startTestService({ provider });
  let settings = loadSettings(t.ctx);
  settings.llm.autoTranslate = false;
  saveSettings(t.ctx, settings);
  await uploadJson(t.service, { "common.json": { title: "Play Quaso" } }, { languages: ["de"] });
  for (const term of [
    { term: "Play", language: "de", kind: "translate" as const, translation: "Spielen" },
    { term: "Quaso", kind: "keep" as const },
    { term: "absent", kind: "keep" as const },
    { term: "Play", language: "fr", kind: "translate" as const, translation: "Jouer" },
  ])
    await t.service.createGlossaryTerm(SYSTEM, term);
  await t.service.createJob(SYSTEM, { languages: ["de"] });
  await drain(t);
  const prompt = provider.requests.map((r) => r.system + r.prompt).join("\n");
  assertStringIncludes(prompt, '"translation":"Spielen"');
  assertStringIncludes(prompt, "Never translate");
  assert(!prompt.includes('"term":"absent"'));
  assert(!prompt.includes('"translation":"Jouer"'));
  settings = loadSettings(t.ctx);
  settings.llm.context.glossary = false;
  saveSettings(t.ctx, settings);
  provider.requests.length = 0;
  await t.service.createJob(SYSTEM, { languages: ["de"], retranslate: true });
  await drain(t);
  assert(provider.requests.length > 0);
  assert(
    !provider.requests
      .map((r) => r.system + r.prompt)
      .join("\n")
      .includes('"translation":"Spielen"'),
  );
});

test("uploads expose suggested renames in activity for the management UI", async () => {
  using t = await startTestService();
  await uploadJson(t.service, { "common.json": { old: "Same English" } }, { languages: ["de"] });
  await t.service.saveTranslation(SYSTEM, {
    id: stringId(t.sql, "common.json", "old"),
    language: "de",
    value: "Gleicher Text",
    baseRevision: 0,
  });
  const upload = await uploadJson(t.service, { "common.json": { renamed: "Same English" } });
  assertEquals(upload.renameSuggestions.length, 1);
  const activity = await t.service.getActivity(ANONYMOUS, {});
  assertEquals(activity.items[0].detail.renameSuggestions, upload.renameSuggestions);
});

test("community privacy: account deletion anonymizes every public attribution and revokes stale writes", async () => {
  using t = await startTestService({ passwordIterations: 1000 });
  await t.service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
  addUser(t.sql, "administrator");
  await uploadJson(t.service, { "common.json": { title: "Quaso" } }, { languages: ["de"] });
  const { user } = await t.service.signUp(ANONYMOUS, {
    email: "private@example.com",
    displayName: "Private Name",
    password: "a sufficiently long password",
  });
  const actor = { type: "user" as const, userId: user.id };
  await t.service.updateMember(SYSTEM, { id: user.id, role: "manager" });
  t.sql.run(
    "UPDATE users SET avatar_url = ? WHERE id = ?",
    "https://example.com/private-avatar.png",
    user.id,
  );
  const string = stringId(t.sql, "common.json", "title");
  const term = await t.service.createGlossaryTerm(actor, { term: "Quaso", kind: "keep" });
  const comment = await t.service.addComment(actor, {
    stringId: string,
    body: "Please clarify this source",
    sourceIssue: true,
  });
  await t.service.resolveComment(actor, { id: comment.id });
  await t.service.requestLanguage(actor, { tag: "fr", message: "More languages please" });
  await t.service.deleteAccount(actor, {
    confirm: "delete",
    password: "a sufficiently long password",
  });
  const comments = await t.service.listComments(ANONYMOUS, { stringId: string });
  const glossary = await t.service.listGlossary(ANONYMOUS, {});
  const requests = await t.service.listLanguageRequests(ANONYMOUS, {});
  assertEquals(comments.comments[0].author.name, "Deleted user");
  assertEquals(comments.comments[0].resolvedBy?.name, "Deleted user");
  assertEquals(glossary.terms[0].createdBy?.name, "Deleted user");
  assertEquals(requests.requests[0].requestedBy?.name, "Deleted user");
  const publicData = JSON.stringify({ comments, glossary, requests });
  for (const personal of ["private@example.com", "Private Name", "private-avatar.png"]) {
    assert(!publicData.includes(personal));
  }
  // Authenticated cookies may outlive the account; ownership never overrides deletion.
  for (const operation of [
    () => t.service.deleteComment(actor, { id: comment.id }),
    () => t.service.resolveComment(actor, { id: comment.id }),
    () => t.service.updateGlossaryTerm(actor, { id: term.id, note: "Still here" }),
    () => t.service.requestLanguage(actor, { tag: "fr" }),
  ])
    assertEquals((await assertRejects(operation, ServiceError)).code, "forbidden");
});
