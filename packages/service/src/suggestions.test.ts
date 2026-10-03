// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "@quaso/runtime/assert";
import type { ExportResult } from "@quaso/core";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, count, stringId, type TestInstance, uploadJson, write } from "./test_helpers.ts";
import { drain } from "./jobs/testing.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import { ENGLISH, projectService } from "./testing/people.ts";

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await assertRejects(() => promise, ServiceError);
  assertEquals(error.code, code, error.message);
  return error;
}

function idOf(instance: TestInstance, key: string): number {
  return stringId(instance.sql, "common.json", key);
}

/** The French file as a download renders it, as an object. */
async function frenchDownload(instance: TestInstance): Promise<Record<string, unknown>> {
  const result: ExportResult = await instance.service.exportFiles(SYSTEM, { languages: ["fr"] });
  const file = result.files.find((f) => f.language === "fr" && f.path === "common.json")!;
  return JSON.parse(file.content);
}

function team(instance: TestInstance) {
  const contributor = addUser(instance.sql, "contributor", ["fr"], "Camille");
  const other = addUser(instance.sql, "contributor", null, "Dana");
  const manager = addUser(instance.sql, "manager", null, "Morgan");
  return { contributor, other, manager };
}

test("suggestions: a contributor's translation is pending, and never downloaded", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor } = team(instance);
  const play = idOf(instance, "play");
  const sent = await service.suggest(contributor, {
    id: play,
    language: "fr",
    kind: "translation",
    value: "Jouer",
    baseRevision: 0,
  });
  assertEquals(
    [sent.kind, sent.status, sent.value, sent.author.name, sent.current, sent.source],
    ["translation", "pending", "Jouer", "Camille", null, "Play"],
  );
  assertEquals(
    [sent.file, sent.key, sent.language, sent.baseRevision],
    ["common.json", "play", "fr", 0],
  );
  assertEquals((await frenchDownload(instance)).play, "Play", "the English, until approved");
  const listed = await service.listStrings(ANONYMOUS, { language: "fr", state: "pending" });
  assertEquals(
    listed.strings.map((s) => [s.key, s.pending, s.translation]),
    [["play", 1, null]],
  );
  const history = await service.getHistory(ANONYMOUS, { id: play, language: "fr" });
  assertEquals(history.entries[0].event, "suggestion_created");
  assertEquals(history.entries[0].actor.name, "Camille");
  assertEquals(history.entries[0].after, "Jouer");
  assertEquals(history.entries[0].detail, { suggestionId: sent.id, kind: "translation" });
});

test("suggestions: who may send them, and in which languages (ROLE-3)", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, manager } = team(instance);
  const input = {
    id: idOf(instance, "play"),
    language: "de",
    kind: "translation" as const,
    value: "Spielen",
    baseRevision: 0,
  };
  await rejectsWith(service.suggest(ANONYMOUS, input), "unauthorized");
  await rejectsWith(service.suggest(addUser(instance.sql, "none"), input), "forbidden");
  await rejectsWith(service.suggest(contributor, input), "forbidden");
  const token = await service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
  await rejectsWith(service.suggest({ type: "token", tokenId: token.id }, input), "forbidden");
  // Managers may ask for a second opinion too.
  assertEquals((await service.suggest(manager, input)).status, "pending");
  await rejectsWith(service.suggest(manager, { ...input, language: "en" }), "bad_request");
  await rejectsWith(service.suggest(manager, { ...input, id: 9999 }), "not_found");
});

test("suggestions: the checks run on sending; stale revisions conflict", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor } = team(instance);
  const items = idOf(instance, "items");
  const error = await rejectsWith(
    service.suggest(contributor, {
      id: items,
      language: "fr",
      kind: "translation",
      value: { one: "un objet", many: "{{count}} objets", other: "{{count}} objets" },
      baseRevision: 0,
    }),
    "qa_failed",
  );
  assertEquals(error.details?.[0].check, "placeholder_missing");
  assertEquals(error.details?.[0].key, "items");
  assertEquals(error.details?.[0].language, "fr");

  write(instance, "common.json", "play", "fr", "Jouer");
  const conflict = await rejectsWith(
    service.suggest(contributor, {
      id: idOf(instance, "play"),
      language: "fr",
      kind: "correction",
      value: "Lancer",
      baseRevision: 0,
    }),
    "conflict",
  );
  assertEquals(conflict.current?.value, "Jouer");
  assertEquals(count(instance.sql, "suggestions"), 0);
});

test('suggestions: corrections, "looks good", and the kind follows the state', async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor } = team(instance);
  const play = idOf(instance, "play");
  const green = write(instance, "common.json", "play", "fr", "Jouer");
  const base = { id: play, language: "fr", baseRevision: green.revision };

  // A "translation" of a translated string is a correction.
  const correction = await service.suggest(contributor, {
    ...base,
    kind: "translation",
    value: "Lancer",
  });
  assertEquals([correction.kind, correction.current?.value], ["correction", "Jouer"]);
  // Repeating the green text is a "looks good".
  const same = await service.suggest(contributor, { ...base, kind: "correction", value: "Jouer" });
  assertEquals([same.kind, same.value], ["approval", null]);
  assertEquals(
    (await service.getString(ANONYMOUS, { id: play, language: "fr" })).suggestions.map((s) => [
      s.id,
      s.status,
    ]),
    [
      [same.id, "pending"],
      [correction.id, "superseded"],
    ],
    "the author's newer suggestion replaces the older one",
  );

  await rejectsWith(
    service.suggest(contributor, { ...base, kind: "approval", value: "x" }),
    "bad_request",
  );
  await rejectsWith(service.suggest(contributor, { ...base, kind: "correction" }), "bad_request");
  await rejectsWith(
    service.suggest(contributor, {
      id: idOf(instance, "save"),
      language: "fr",
      kind: "approval",
      baseRevision: 0,
    }),
    "bad_request",
  );
  const blue = write(instance, "common.json", "save", "fr", "Sauvegarder", {
    colour: "blue",
    actor: { type: "user", id: null, label: null },
    event: "translation_saved",
  });
  await rejectsWith(
    service.suggest(contributor, {
      id: idOf(instance, "save"),
      language: "fr",
      kind: "approval",
      baseRevision: blue.revision,
    }),
    "bad_request",
  );
  await rejectsWith(
    service.suggest(contributor, {
      id: idOf(instance, "save"),
      language: "fr",
      kind: "correction",
      value: "Sauvegarder",
      baseRevision: blue.revision,
    }),
    "bad_request",
  );
  const onBlue = await service.suggest(contributor, {
    id: idOf(instance, "save"),
    language: "fr",
    kind: "correction",
    value: "Enregistrer la partie",
    baseRevision: blue.revision,
  });
  assertEquals([onBlue.kind, onBlue.current?.colour], ["correction", "blue"]);
});

test("suggestions: authors withdraw their pending ones", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, other } = team(instance);
  const sent = await service.suggest(contributor, {
    id: idOf(instance, "play"),
    language: "fr",
    kind: "translation",
    value: "Jouer",
    baseRevision: 0,
  });
  await rejectsWith(service.withdrawSuggestion(other, { id: sent.id }), "forbidden");
  await rejectsWith(service.withdrawSuggestion(ANONYMOUS, { id: sent.id }), "unauthorized");
  const withdrawn = await service.withdrawSuggestion(contributor, { id: sent.id });
  assertEquals([withdrawn.status, withdrawn.reviewedAt], ["withdrawn", instance.clock.now]);
  await rejectsWith(service.withdrawSuggestion(contributor, { id: sent.id }), "bad_request");
  await rejectsWith(service.withdrawSuggestion(contributor, { id: 999 }), "not_found");
});

test("suggestions: managers list everyone's, contributors their own", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, other, manager } = team(instance);
  const send = (actor: Actor, key: string, language: string, value: string) =>
    service.suggest(actor, {
      id: idOf(instance, key),
      language,
      kind: "translation",
      value,
      baseRevision: 0,
    });
  const a = await send(contributor, "play", "fr", "Jouer");
  const b = await send(other, "play", "de", "Spielen");
  const c = await send(other, "quit", "fr", "Quitter");

  const ids = (page: { suggestions: { id: number }[] }) => page.suggestions.map((s) => s.id);
  assertEquals(ids(await service.listSuggestions(manager, {})), [a.id, b.id, c.id], "oldest first");
  assertEquals(ids(await service.listSuggestions(manager, { language: "fr" })), [a.id, c.id]);
  const otherId = other.type === "user" ? other.userId : 0;
  assertEquals(ids(await service.listSuggestions(manager, { author: String(otherId) })), [
    b.id,
    c.id,
  ]);
  assertEquals(ids(await service.listSuggestions(contributor, {})), [a.id]);
  assertEquals(ids(await service.listSuggestions(contributor, { author: "me" })), [a.id]);
  await rejectsWith(service.listSuggestions(contributor, { author: String(otherId) }), "forbidden");
  await rejectsWith(service.listSuggestions(ANONYMOUS, {}), "unauthorized");
  await rejectsWith(service.listSuggestions(manager, { author: "someone" }), "bad_request");

  const page = await service.listSuggestions(manager, { limit: 2 });
  assertEquals([page.total, page.nextCursor, page.suggestions.length], [3, "2", 2]);
  assertEquals(ids(await service.listSuggestions(manager, { cursor: "2" })), [c.id]);
  assertEquals(ids(await service.listSuggestions(manager, { file: "other.json" })), []);
  assertEquals(ids(await service.listSuggestions(manager, { kind: "correction" })), []);

  await service.withdrawSuggestion(other, { id: b.id });
  assertEquals(ids(await service.listSuggestions(manager, { status: "withdrawn" })), [b.id]);
  assertEquals(ids(await service.listSuggestions(manager, { status: "all" })), [c.id, b.id, a.id]);
  const detail = (await service.listSuggestions(manager, { language: "fr", limit: 1 }))
    .suggestions[0];
  assertEquals([detail.source, detail.current, detail.checks], ["Play", null, []]);
});

test("review: approving writes blue with author and approver, and supersedes the rest (STR-5)", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, other, manager } = team(instance);
  const play = idOf(instance, "play");
  const green = write(instance, "common.json", "play", "fr", "Jouer");
  const base = {
    id: play,
    language: "fr",
    kind: "correction" as const,
    baseRevision: green.revision,
  };
  const mine = await service.suggest(contributor, { ...base, value: "Lancer la partie" });
  const theirs = await service.suggest(other, { ...base, value: "Commencer" });
  assertEquals((await frenchDownload(instance)).play, "Jouer");

  await rejectsWith(
    service.reviewSuggestions(contributor, { ids: [mine.id], action: "approve" }),
    "forbidden",
  );
  const result = await service.reviewSuggestions(manager, {
    ids: [mine.id, theirs.id],
    action: "approve",
    comment: "Merci !",
  });
  assertEquals(result.approved, [mine.id]);
  assertEquals(result.rejected, []);
  assertEquals(
    result.failed.map((f) => [f.id, f.code]),
    [[theirs.id, "conflict"]],
  );

  const detail = await service.getString(ANONYMOUS, { id: play, language: "fr" });
  assertEquals(detail.translation?.value, "Lancer la partie");
  assertEquals(detail.translation?.colour, "blue");
  assertEquals(detail.translation?.author.name, "Camille");
  assertEquals(detail.translation?.approver?.name, "Morgan");
  assertEquals(
    detail.suggestions.map((s) => [s.id, s.status, s.reviewer?.name, s.comment]),
    [
      [theirs.id, "superseded", "Morgan", null],
      [mine.id, "approved", "Morgan", "Merci !"],
    ],
  );
  assertEquals((await frenchDownload(instance)).play, "Lancer la partie");

  const history = await service.getHistory(ANONYMOUS, { id: play, language: "fr" });
  const approved = history.entries.find((e) => e.event === "suggestion_approved")!;
  assertEquals(approved.actor.name, "Morgan");
  assertEquals([approved.before, approved.after], ["Jouer", "Lancer la partie"]);
  assertEquals([approved.beforeColour, approved.afterColour], ["green", "blue"]);
  const contributorId = contributor.type === "user" ? contributor.userId : 0;
  assertEquals(approved.detail, {
    suggestionId: mine.id,
    kind: "correction",
    author: { type: "user", id: contributorId },
    comment: "Merci !",
  });
  const superseded = history.entries.find((e) => e.event === "suggestion_superseded")!;
  assertEquals(superseded.detail, { suggestionId: theirs.id, supersededBy: mine.id });

  const activity = await service.getActivity(ANONYMOUS, {});
  assertEquals(activity.items[0].type, "review");
  assertEquals(activity.items[0].summary, "Review (fr): 1 approved");
  assertEquals(activity.items[0].actor.name, "Morgan");
});

test("review: rejecting only changes the suggestion", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, manager } = team(instance);
  const sent = await service.suggest(contributor, {
    id: idOf(instance, "play"),
    language: "fr",
    kind: "translation",
    value: "Jouer",
    baseRevision: 0,
  });
  const result = await service.reviewSuggestions(manager, {
    ids: [sent.id],
    action: "reject",
    comment: "Trop court",
  });
  assertEquals(result, { approved: [], rejected: [sent.id], failed: [] });
  const [row] = await service
    .listSuggestions(contributor, { status: "rejected" })
    .then((p) => p.suggestions);
  assertEquals([row.status, row.comment, row.reviewer?.name], ["rejected", "Trop court", "Morgan"]);
  assertEquals(
    (await service.getString(ANONYMOUS, { id: idOf(instance, "play"), language: "fr" }))
      .translation,
    null,
  );
  const history = await service.getHistory(ANONYMOUS, {
    id: idOf(instance, "play"),
    language: "fr",
  });
  assertEquals(
    history.entries.map((e) => e.event),
    ["suggestion_rejected", "suggestion_created", "source_added"],
  );
  assertEquals(
    (await service.getActivity(ANONYMOUS, {})).items[0].summary,
    "Review (fr): 1 rejected",
  );
});

test("review: the checks run again against the current English; the rest proceed", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, manager } = team(instance);
  const quit = await service.suggest(contributor, {
    id: idOf(instance, "quit"),
    language: "fr",
    kind: "translation",
    value: "Quitter",
    baseRevision: 0,
  });
  const play = await service.suggest(contributor, {
    id: idOf(instance, "play"),
    language: "fr",
    kind: "translation",
    value: "Jouer",
    baseRevision: 0,
  });
  // The English of "quit" now has a placeholder the suggestion lacks.
  await uploadJson(service, { "common.json": { ...ENGLISH, quit: "Quit {{game}}" } });
  const result = await service.reviewSuggestions(manager, {
    ids: [quit.id, play.id, 999],
    action: "approve",
  });
  assertEquals(result.approved, [play.id]);
  assertEquals(
    result.failed.map((f) => [f.id, f.code]),
    [
      [quit.id, "qa_failed"],
      [999, "not_found"],
    ],
  );
  assertEquals(result.failed[0].checks?.[0].check, "placeholder_missing");
  const still = (await service.listSuggestions(manager, {})).suggestions;
  assertEquals(
    still.map((s) => [s.id, s.status]),
    [[quit.id, "pending"]],
  );
  assertEquals((await frenchDownload(instance)).play, "Jouer");
});

test("review: language limits apply per suggestion", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { other } = team(instance);
  const germanManager = addUser(instance.sql, "manager", ["de"], "Germanist");
  const fr = await service.suggest(other, {
    id: idOf(instance, "play"),
    language: "fr",
    kind: "translation",
    value: "Jouer",
    baseRevision: 0,
  });
  const de = await service.suggest(other, {
    id: idOf(instance, "play"),
    language: "de",
    kind: "translation",
    value: "Spielen",
    baseRevision: 0,
  });
  const result = await service.reviewSuggestions(germanManager, {
    ids: [fr.id, de.id],
    action: "approve",
  });
  assertEquals(result.approved, [de.id]);
  assertEquals(
    result.failed.map((f) => [f.id, f.code]),
    [[fr.id, "forbidden"]],
  );
});

test('review: "looks good" approves the green text as it was, and only that', async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, manager } = team(instance);
  const green = write(instance, "common.json", "play", "fr", "Jouer");
  const looksGood = await service.suggest(contributor, {
    id: idOf(instance, "play"),
    language: "fr",
    kind: "approval",
    baseRevision: green.revision,
  });
  assertEquals([looksGood.kind, looksGood.value, looksGood.checks], ["approval", null, []]);
  const result = await service.reviewSuggestions(manager, {
    ids: [looksGood.id],
    action: "approve",
  });
  assertEquals(result.approved, [looksGood.id]);
  const translation = (
    await service.getString(ANONYMOUS, { id: idOf(instance, "play"), language: "fr" })
  ).translation!;
  assertEquals(
    [translation.value, translation.colour, translation.author.name, translation.approver?.name],
    ["Jouer", "blue", "test-model", "Morgan"],
  );

  // Once the text changed, the "looks good" no longer applies.
  const quit = write(instance, "common.json", "quit", "fr", "Quitter");
  const stale = await service.suggest(contributor, {
    id: idOf(instance, "quit"),
    language: "fr",
    kind: "approval",
    baseRevision: quit.revision,
  });
  write(instance, "common.json", "quit", "fr", "Sortir");
  const failed = await service.reviewSuggestions(manager, { ids: [stale.id], action: "approve" });
  assertEquals(
    failed.failed.map((f) => f.code),
    ["conflict"],
  );
});

test("review: an LLM proposal for an outdated blue translation, approved in one click", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { manager } = team(instance);
  const play = idOf(instance, "play");
  write(instance, "common.json", "play", "fr", "Jouer", {
    colour: "blue",
    actor: { type: "user", id: null, label: null },
    event: "translation_saved",
  });
  const [{ id }] = instance.sql.query<{ id: number }>(
    `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
       status, author_type, author_label, created_at)
     SELECT s.id, 'fr', 'llm', '"Jouer maintenant"', s.source_hash, t.revision, 'pending', 'llm',
       'gemini-test', 0
     FROM strings s JOIN translations t ON t.string_id = s.id AND t.language = 'fr'
     WHERE s.id = ? RETURNING id`,
    play,
  );
  const result = await service.reviewSuggestions(manager, { ids: [id], action: "approve" });
  assertEquals(result.approved, [id]);
  const translation = (await service.getString(ANONYMOUS, { id: play, language: "fr" }))
    .translation!;
  assertEquals(
    [translation.value, translation.colour, translation.author.type, translation.author.name],
    ["Jouer maintenant", "blue", "llm", "gemini-test"],
  );
  assertEquals(translation.approver?.name, "Morgan");
  assert(count(instance.sql, "activity", "type = 'review'") === 1);
});

test("review: a suggestion a person's edit outgrew leaves the queue, and can't be approved (409)", async () => {
  using instance = await projectService({ provider: createFakeTranslator() });
  const { service } = instance;
  const { contributor, manager } = team(instance);
  const lead = addUser(instance.sql, "manager", null, "Lee");
  const play = idOf(instance, "play");
  const translation = async () =>
    (await service.getString(SYSTEM, { id: play, language: "fr" })).translation!;
  // A blue translation, a contributor's correction of it, and, once the English changes,
  // the LLM's proposal for it.
  const saved = await service.saveTranslation(manager, {
    id: play,
    language: "fr",
    value: "Jouer",
    baseRevision: 0,
  });
  const correction = await service.suggest(contributor, {
    id: play,
    language: "fr",
    kind: "correction",
    value: "Lancer",
    baseRevision: saved.translation!.revision,
  });
  await uploadJson(
    service,
    { "common.json": { ...ENGLISH, play: "Play now" } },
    {
      languages: ["de", "fr"],
    },
  );
  await drain(instance);
  await service.createJob(manager, { languages: ["fr"], strings: [play] });
  await drain(instance);
  const [proposal] = (await service.listSuggestions(lead, { language: "fr", kind: "llm" }))
    .suggestions;
  assertEquals(proposal.baseRevision, saved.translation!.revision);

  // The manager fixes the text directly: both are stale now, and superseded.
  await service.saveTranslation(manager, {
    id: play,
    language: "fr",
    value: "Jouer maintenant",
    baseRevision: (await translation()).revision,
  });
  assertEquals((await service.listSuggestions(lead, { language: "fr" })).suggestions, []);
  const mine = await service.listSuggestions(contributor, { author: "me", status: "all" });
  assertEquals(
    mine.suggestions.map((s) => s.status),
    ["superseded"],
  );
  const result = await service.reviewSuggestions(lead, {
    ids: [correction.id, proposal.id],
    action: "approve",
  });
  assertEquals(result.approved, []);
  assertEquals(
    result.failed.map((f) => [f.id, f.code]),
    [
      [correction.id, "conflict"],
      [proposal.id, "conflict"],
    ],
  );
  const after = await translation();
  assertEquals(
    [after.value, after.colour, after.author.name],
    ["Jouer maintenant", "blue", "Morgan"],
  );
});

test("review: approving refuses to overwrite a newer blue, but may replace a newer green", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, manager } = team(instance);
  const play = idOf(instance, "play");
  const quit = idOf(instance, "quit");
  const translation = async (id: number) =>
    (await service.getString(SYSTEM, { id, language: "fr" })).translation!;

  // Translations for red strings; then the LLM translates one, and a person (through
  // another path than a direct edit, such as an import) writes the other blue.
  const sent = [];
  for (const [id, value] of [
    [play, "Jouer"],
    [quit, "Quitter"],
  ] as const) {
    sent.push(
      await service.suggest(contributor, {
        id,
        language: "fr",
        kind: "translation",
        value,
        baseRevision: 0,
      }),
    );
  }
  write(instance, "common.json", "play", "fr", "Jouer (LLM)");
  write(instance, "common.json", "quit", "fr", "Sortir", {
    colour: "blue",
    actor: { type: "user", id: null, label: null },
    event: "translation_saved",
  });
  const result = await service.reviewSuggestions(manager, {
    ids: sent.map((s) => s.id),
    action: "approve",
  });
  assertEquals(result.approved, [sent[0].id], "a person's text replaces the LLM's green");
  assertEquals(
    result.failed.map((f) => [f.id, f.code]),
    [[sent[1].id, "conflict"]],
  );
  assertEquals((await translation(play)).value, "Jouer");
  assertEquals(
    [(await translation(quit)).value, (await translation(quit)).colour],
    ["Sortir", "blue"],
  );
});

test("review: a suggestion made for older English is approved outdated (STR-4)", async () => {
  using instance = await projectService();
  const { service } = instance;
  const { contributor, manager } = team(instance);
  const play = idOf(instance, "play");
  const save = idOf(instance, "save");
  const translation = async (id: number) =>
    (await service.getString(SYSTEM, { id, language: "fr" })).translation!;
  const sent = await service.suggest(contributor, {
    id: play,
    language: "fr",
    kind: "translation",
    value: "Jouer",
    baseRevision: 0,
  });
  // A green translation, outdated by the next upload, gets a "looks good" for the new English.
  write(instance, "common.json", "save", "fr", "Sauvegarder la partie");
  await uploadJson(
    service,
    { "common.json": { ...ENGLISH, play: "Stop", save: "Save it" } },
    {
      languages: ["de", "fr"],
    },
  );
  assertEquals((await translation(save)).outdated, true);
  const looksGood = await service.suggest(contributor, {
    id: save,
    language: "fr",
    kind: "approval",
    baseRevision: (await translation(save)).revision,
  });

  const result = await service.reviewSuggestions(manager, {
    ids: [sent.id, looksGood.id],
    action: "approve",
  });
  assertEquals(result.approved, [sent.id, looksGood.id]);
  // "Jouer" was written for "Play", not "Stop": blue, and still outdated.
  const approved = await translation(play);
  assertEquals([approved.value, approved.colour, approved.outdated], ["Jouer", "blue", true]);
  const outdated = await service.listStrings(ANONYMOUS, { language: "fr", state: "outdated" });
  assertEquals(
    outdated.strings.map((s) => s.key),
    ["play"],
  );
  // The "looks good" confirmed the text for the English the contributor saw: current.
  const confirmed = await translation(save);
  assertEquals([confirmed.colour, confirmed.outdated], ["blue", false]);
});
