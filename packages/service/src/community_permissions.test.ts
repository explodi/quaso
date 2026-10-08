// SPDX-License-Identifier: MIT
import { test } from "node:test";
/** Community features must preserve the same access and publication boundaries as translations. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { ANONYMOUS } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, stringId, uploadJson } from "./test_helpers.ts";
import { projectService } from "./testing/people.ts";

async function denied(promise: Promise<unknown>, code = "forbidden") {
  const error = await assertRejects(() => promise, ServiceError);
  assertEquals(error.code, code);
}

test("community glossary: scope applies to both the old and new language, including global terms", async () => {
  using instance = await projectService();
  const { service, sql, admin } = instance;
  const manager = addUser(sql, "manager", ["de"]);
  const contributor = addUser(sql, "contributor", ["de"]);
  const input = { term: "game", kind: "translate" as const, translation: "Spiel", language: "de" };
  await denied(service.createGlossaryTerm(ANONYMOUS, input), "unauthorized");
  await denied(service.createGlossaryTerm(contributor, input));
  await denied(service.createGlossaryTerm(manager, { ...input, language: "fr" }));
  await denied(service.createGlossaryTerm(manager, { ...input, language: null }));
  const german = await service.createGlossaryTerm(manager, input);
  await denied(service.updateGlossaryTerm(manager, { id: german.id, language: "fr" }));
  await denied(service.updateGlossaryTerm(manager, { id: german.id, language: null }));
  const french = await service.createGlossaryTerm(admin, {
    ...input,
    language: "fr",
    translation: "jeu",
  });
  await denied(service.updateGlossaryTerm(manager, { id: french.id, language: "de" }));
  await denied(service.deleteGlossaryTerm(manager, { id: french.id }));
  assertEquals((await service.listGlossary(ANONYMOUS, { language: "de" })).terms.length, 1);
  const global = await service.createGlossaryTerm(admin, { term: "Quaso", kind: "keep" });
  await denied(service.createGlossaryTerm(admin, { term: "QUASO", kind: "keep" }), "conflict");
  await service.deleteGlossaryTerm(admin, { id: global.id });
});

test("community glossary: whole words filter editor context and edits recompute QA warnings", async () => {
  using instance = await projectService();
  const { service, sql, admin } = instance;
  await uploadJson(
    service,
    { "common.json": { play: "Save the game", other: "An endgame" } },
    {
      languages: ["de"],
    },
  );
  const id = stringId(sql, "common.json", "play");
  await service.saveTranslation(admin, {
    id,
    language: "de",
    value: "Fortschritt sichern",
    baseRevision: 0,
  });
  const term = await service.createGlossaryTerm(admin, {
    term: "game",
    kind: "translate",
    language: "de",
    translation: "Spiel",
  });
  const detail = await service.getString(ANONYMOUS, { id, language: "de" });
  assert(detail.checks.some((check) => check.check === "glossary"));
  assertEquals(detail.translation?.qa.warnings, 1);
  assertEquals(
    (await service.listGlossary(ANONYMOUS, { language: "de", stringId: id })).terms.length,
    1,
  );
  assertEquals(
    (
      await service.listGlossary(ANONYMOUS, {
        language: "de",
        stringId: stringId(sql, "common.json", "other"),
      })
    ).terms.length,
    0,
  );
  await service.deleteGlossaryTerm(admin, { id: term.id });
  assertEquals(
    (await service.getString(ANONYMOUS, { id, language: "de" })).translation?.qa.warnings,
    0,
  );
});

test("community comments: pending volunteers, language grants, resolution and soft deletion", async () => {
  using instance = await projectService();
  const { service, sql, admin } = instance;
  const id = stringId(sql, "common.json", "play");
  const visitor = addUser(sql, "none");
  const contributor = addUser(sql, "contributor", ["de"]);
  const germanManager = addUser(sql, "manager", ["de"]);
  const frenchManager = addUser(sql, "manager", ["fr"]);
  await denied(service.addComment(ANONYMOUS, { stringId: id, body: "A note" }), "unauthorized");
  await denied(service.addComment(visitor, { stringId: id, body: "A note" }));
  await service.requestVolunteer(visitor, { languages: ["de"], message: "I can help" });
  const pending = await service.addComment(visitor, {
    stringId: id,
    body: "The English is unclear",
    sourceIssue: true,
  });
  await denied(service.addComment(contributor, { stringId: id, body: "A note", language: "fr" }));
  const comment = await service.addComment(contributor, {
    stringId: id,
    body: "German wording",
    language: "de",
  });
  await denied(service.resolveComment(frenchManager, { id: comment.id }));
  await service.resolveComment(germanManager, { id: comment.id });
  await denied(service.deleteComment(germanManager, { id: comment.id }));
  await service.deleteComment(contributor, { id: comment.id });
  assertEquals(
    (await service.listComments(ANONYMOUS, { stringId: id })).comments.map((row) => row.id),
    [pending.id],
  );
  assertEquals(
    sql.query<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM comments WHERE id = ?",
      comment.id,
    )[0].deleted_at !== null,
    true,
  );
  await denied(service.listComments(ANONYMOUS, { sourceIssue: true }), "unauthorized");
  await service.resolveComment(visitor, { id: pending.id });
  assertEquals(
    (await service.listComments(admin, { sourceIssue: true, resolved: false })).comments.length,
    0,
  );
  await denied(service.addComment(contributor, { stringId: id, body: "   " }), "bad_request");
});

test("community language requests: canonical tags, one vote per person, and atomic approval", async () => {
  using instance = await projectService();
  const { service, sql, admin } = instance;
  const visitor = addUser(sql, "none");
  const second = addUser(sql, "contributor");
  const manager = addUser(sql, "manager");
  await service.updateSettings(admin, { languageRequestsEnabled: true });
  await denied(service.requestLanguage(ANONYMOUS, { tag: "pt-br" }), "unauthorized");
  const first = await service.requestLanguage(visitor, {
    tag: "pt-br",
    message: "Brazilian community",
  });
  assertEquals(first.tag, "pt-BR");
  assertEquals(first.votes, 1);
  const again = await service.requestLanguage(visitor, { tag: "pt-BR" });
  assertEquals(again.id, first.id);
  assertEquals(again.votes, 1);
  assertEquals((await service.requestLanguage(second, { tag: "pt-br" })).votes, 2);
  await denied(service.reviewLanguageRequest(manager, { id: first.id, action: "approve" }));
  const approved = await service.reviewLanguageRequest(admin, { id: first.id, action: "approve" });
  assertEquals(approved.status, "approved");
  assertEquals((await service.listLanguageRequests(ANONYMOUS, {})).requests.length, 0);
  assert(
    (await service.getProject(ANONYMOUS, {})).languages.some(
      (language) => language.tag === "pt-BR",
    ),
  );
  await denied(
    service.reviewLanguageRequest(admin, { id: first.id, action: "reject" }),
    "conflict",
  );
  await assertRejects(() => service.requestLanguage(visitor, { tag: "pt-BR" }), ServiceError);
  await denied(service.requestLanguage(visitor, { tag: "en" }), "bad_request");
});
