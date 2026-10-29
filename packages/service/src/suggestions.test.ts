// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import type { ExportResult } from "@quaso/core";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, count, stringId, type TestInstance, uploadJson, write } from "./test_helpers.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import { ENGLISH, projectService } from "./testing/people.ts";

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code, error.message).toStrictEqual(code);
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
  expect([
    sent.kind,
    sent.status,
    sent.value,
    sent.author.name,
    sent.current,
    sent.source,
  ]).toStrictEqual(["translation", "pending", "Jouer", "Camille", null, "Play"]);
  expect([sent.file, sent.key, sent.language, sent.baseRevision]).toStrictEqual([
    "common.json",
    "play",
    "fr",
    0,
  ]);
  expect((await frenchDownload(instance)).play, "the English, until approved").toStrictEqual(
    "Play",
  );
  const listed = await service.listStrings(ANONYMOUS, { language: "fr", state: "pending" });
  expect(listed.strings.map((s) => [s.key, s.pending, s.translation])).toStrictEqual([
    ["play", 1, null],
  ]);
  const history = await service.getHistory(ANONYMOUS, { id: play, language: "fr" });
  expect(history.entries[0].event).toBe("suggestion_created");
  expect(history.entries[0].actor.name).toBe("Camille");
  expect(history.entries[0].after).toBe("Jouer");
  expect(history.entries[0].detail).toStrictEqual({ suggestionId: sent.id, kind: "translation" });
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
  expect((await service.suggest(manager, input)).status).toBe("pending");
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
  expect(error.details?.[0].check).toBe("placeholder_missing");
  expect(error.details?.[0].key).toBe("items");
  expect(error.details?.[0].language).toBe("fr");

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
  expect(conflict.current?.value).toBe("Jouer");
  expect(count(instance.sql, "suggestions")).toBe(0);
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
  expect([correction.kind, correction.current?.value]).toStrictEqual(["correction", "Jouer"]);
  // Repeating the green text is a "looks good".
  const same = await service.suggest(contributor, { ...base, kind: "correction", value: "Jouer" });
  expect([same.kind, same.value]).toStrictEqual(["approval", null]);
  expect(
    (await service.getString(ANONYMOUS, { id: play, language: "fr" })).suggestions.map((s) => [
      s.id,
      s.status,
    ]),
    "the author's newer suggestion replaces the older one",
  ).toStrictEqual([
    [same.id, "pending"],
    [correction.id, "superseded"],
  ]);

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
  expect([onBlue.kind, onBlue.current?.colour]).toStrictEqual(["correction", "blue"]);
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
  expect([withdrawn.status, withdrawn.reviewedAt]).toStrictEqual(["withdrawn", instance.clock.now]);
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
  expect(ids(await service.listSuggestions(manager, {})), "oldest first").toStrictEqual([
    a.id,
    b.id,
    c.id,
  ]);
  expect(ids(await service.listSuggestions(manager, { language: "fr" }))).toStrictEqual([
    a.id,
    c.id,
  ]);
  const otherId = other.type === "user" ? other.userId : 0;
  expect(ids(await service.listSuggestions(manager, { author: String(otherId) }))).toStrictEqual([
    b.id,
    c.id,
  ]);
  expect(ids(await service.listSuggestions(contributor, {}))).toStrictEqual([a.id]);
  expect(ids(await service.listSuggestions(contributor, { author: "me" }))).toStrictEqual([a.id]);
  await rejectsWith(service.listSuggestions(contributor, { author: String(otherId) }), "forbidden");
  await rejectsWith(service.listSuggestions(ANONYMOUS, {}), "unauthorized");
  await rejectsWith(service.listSuggestions(manager, { author: "someone" }), "bad_request");

  const page = await service.listSuggestions(manager, { limit: 2 });
  expect([page.total, page.nextCursor, page.suggestions.length]).toStrictEqual([3, "2", 2]);
  expect(ids(await service.listSuggestions(manager, { cursor: "2" }))).toStrictEqual([c.id]);
  expect(ids(await service.listSuggestions(manager, { file: "other.json" }))).toStrictEqual([]);
  expect(ids(await service.listSuggestions(manager, { kind: "correction" }))).toStrictEqual([]);

  await service.withdrawSuggestion(other, { id: b.id });
  expect(ids(await service.listSuggestions(manager, { status: "withdrawn" }))).toStrictEqual([
    b.id,
  ]);
  expect(ids(await service.listSuggestions(manager, { status: "all" }))).toStrictEqual([
    c.id,
    b.id,
    a.id,
  ]);
  const detail = (await service.listSuggestions(manager, { language: "fr", limit: 1 }))
    .suggestions[0];
  expect([detail.source, detail.current, detail.checks]).toStrictEqual(["Play", null, []]);
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
  expect((await frenchDownload(instance)).play).toBe("Jouer");

  await rejectsWith(
    service.reviewSuggestions(contributor, { ids: [mine.id], action: "approve" }),
    "forbidden",
  );
  const result = await service.reviewSuggestions(manager, {
    ids: [mine.id, theirs.id],
    action: "approve",
    comment: "Merci !",
  });
  expect(result.approved).toStrictEqual([mine.id]);
  expect(result.rejected).toStrictEqual([]);
  expect(result.failed.map((f) => [f.id, f.code])).toStrictEqual([[theirs.id, "conflict"]]);

  const detail = await service.getString(ANONYMOUS, { id: play, language: "fr" });
  expect(detail.translation?.value).toBe("Lancer la partie");
  expect(detail.translation?.colour).toBe("blue");
  expect(detail.translation?.author.name).toBe("Camille");
  expect(detail.translation?.approver?.name).toBe("Morgan");
  expect(
    detail.suggestions.map((s) => [s.id, s.status, s.reviewer?.name, s.comment]),
  ).toStrictEqual([
    [theirs.id, "superseded", "Morgan", null],
    [mine.id, "approved", "Morgan", "Merci !"],
  ]);
  expect((await frenchDownload(instance)).play).toBe("Lancer la partie");

  const history = await service.getHistory(ANONYMOUS, { id: play, language: "fr" });
  const approved = history.entries.find((e) => e.event === "suggestion_approved")!;
  expect(approved.actor.name).toBe("Morgan");
  expect([approved.before, approved.after]).toStrictEqual(["Jouer", "Lancer la partie"]);
  expect([approved.beforeColour, approved.afterColour]).toStrictEqual(["green", "blue"]);
  const contributorId = contributor.type === "user" ? contributor.userId : 0;
  expect(approved.detail).toStrictEqual({
    suggestionId: mine.id,
    kind: "correction",
    author: { type: "user", id: contributorId },
    comment: "Merci !",
  });
  const superseded = history.entries.find((e) => e.event === "suggestion_superseded")!;
  expect(superseded.detail).toStrictEqual({ suggestionId: theirs.id, supersededBy: mine.id });

  const activity = await service.getActivity(ANONYMOUS, {});
  expect(activity.items[0].type).toBe("review");
  expect(activity.items[0].summary).toBe("Review (fr): 1 approved");
  expect(activity.items[0].actor.name).toBe("Morgan");
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
  expect(result).toStrictEqual({ approved: [], rejected: [sent.id], failed: [] });
  const [row] = await service
    .listSuggestions(contributor, { status: "rejected" })
    .then((p) => p.suggestions);
  expect([row.status, row.comment, row.reviewer?.name]).toStrictEqual([
    "rejected",
    "Trop court",
    "Morgan",
  ]);
  expect(
    (await service.getString(ANONYMOUS, { id: idOf(instance, "play"), language: "fr" }))
      .translation,
  ).toBe(null);
  const history = await service.getHistory(ANONYMOUS, {
    id: idOf(instance, "play"),
    language: "fr",
  });
  expect(history.entries.map((e) => e.event)).toStrictEqual([
    "suggestion_rejected",
    "suggestion_created",
    "source_added",
  ]);
  expect((await service.getActivity(ANONYMOUS, {})).items[0].summary).toStrictEqual(
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
  expect(result.approved).toStrictEqual([play.id]);
  expect(result.failed.map((f) => [f.id, f.code])).toStrictEqual([
    [quit.id, "qa_failed"],
    [999, "not_found"],
  ]);
  expect(result.failed[0].checks?.[0].check).toBe("placeholder_missing");
  const still = (await service.listSuggestions(manager, {})).suggestions;
  expect(still.map((s) => [s.id, s.status])).toStrictEqual([[quit.id, "pending"]]);
  expect((await frenchDownload(instance)).play).toBe("Jouer");
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
  expect(result.approved).toStrictEqual([de.id]);
  expect(result.failed.map((f) => [f.id, f.code])).toStrictEqual([[fr.id, "forbidden"]]);
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
  expect([looksGood.kind, looksGood.value, looksGood.checks]).toStrictEqual(["approval", null, []]);
  const result = await service.reviewSuggestions(manager, {
    ids: [looksGood.id],
    action: "approve",
  });
  expect(result.approved).toStrictEqual([looksGood.id]);
  const translation = (
    await service.getString(ANONYMOUS, { id: idOf(instance, "play"), language: "fr" })
  ).translation!;
  expect([
    translation.value,
    translation.colour,
    translation.author.name,
    translation.approver?.name,
  ]).toStrictEqual(["Jouer", "blue", "test-model", "Morgan"]);

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
  expect(failed.failed.map((f) => f.code)).toStrictEqual(["conflict"]);
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
  expect(result.approved).toStrictEqual([id]);
  const translation = (await service.getString(ANONYMOUS, { id: play, language: "fr" }))
    .translation!;
  expect([
    translation.value,
    translation.colour,
    translation.author.type,
    translation.author.name,
  ]).toStrictEqual(["Jouer maintenant", "blue", "llm", "gemini-test"]);
  expect(translation.approver?.name).toBe("Morgan");
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
  // A blue translation, and a contributor's correction of it.
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

  // The manager fixes the text directly: the correction is stale now, and superseded.
  await service.saveTranslation(manager, {
    id: play,
    language: "fr",
    value: "Jouer maintenant",
    baseRevision: (await translation()).revision,
  });
  expect((await service.listSuggestions(lead, { language: "fr" })).suggestions).toStrictEqual([]);
  const mine = await service.listSuggestions(contributor, { author: "me", status: "all" });
  expect(mine.suggestions.map((s) => s.status)).toStrictEqual(["superseded"]);
  const result = await service.reviewSuggestions(lead, {
    ids: [correction.id],
    action: "approve",
  });
  expect(result.approved).toStrictEqual([]);
  expect(result.failed.map((f) => [f.id, f.code])).toStrictEqual([[correction.id, "conflict"]]);
  const after = await translation();
  expect([after.value, after.colour, after.author.name]).toStrictEqual([
    "Jouer maintenant",
    "blue",
    "Morgan",
  ]);
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
  expect(result.approved, "a person's text replaces the LLM's green").toStrictEqual([sent[0].id]);
  expect(result.failed.map((f) => [f.id, f.code])).toStrictEqual([[sent[1].id, "conflict"]]);
  expect((await translation(play)).value).toBe("Jouer");
  expect([(await translation(quit)).value, (await translation(quit)).colour]).toStrictEqual([
    "Sortir",
    "blue",
  ]);
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
  expect((await translation(save)).outdated).toBe(true);
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
  expect(result.approved).toStrictEqual([sent.id, looksGood.id]);
  // "Jouer" was written for "Play", not "Stop": blue, and still outdated.
  const approved = await translation(play);
  expect([approved.value, approved.colour, approved.outdated]).toStrictEqual([
    "Jouer",
    "blue",
    true,
  ]);
  const outdated = await service.listStrings(ANONYMOUS, { language: "fr", state: "outdated" });
  expect(outdated.strings.map((s) => s.key)).toStrictEqual(["play"]);
  // The "looks good" confirmed the text for the English the contributor saw: current.
  const confirmed = await translation(save);
  expect([confirmed.colour, confirmed.outdated]).toStrictEqual(["blue", false]);
});
