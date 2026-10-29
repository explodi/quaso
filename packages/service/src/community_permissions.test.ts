// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
/** Community features must preserve the same access and publication boundaries as translations. */
import { ANONYMOUS } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, stringId, uploadJson } from "./test_helpers.ts";
import { projectService } from "./testing/people.ts";

async function denied(promise: Promise<unknown>, code = "forbidden") {
  const error = await promise.catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toStrictEqual(code);
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
  expect((await service.listGlossary(ANONYMOUS, { language: "de" })).terms.length).toBe(1);
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
  expect(detail.translation?.qa.warnings).toBe(1);
  expect(
    (await service.listGlossary(ANONYMOUS, { language: "de", stringId: id })).terms.length,
  ).toBe(1);
  expect(
    (
      await service.listGlossary(ANONYMOUS, {
        language: "de",
        stringId: stringId(sql, "common.json", "other"),
      })
    ).terms.length,
  ).toBe(0);
  await service.deleteGlossaryTerm(admin, { id: term.id });
  expect(
    (await service.getString(ANONYMOUS, { id, language: "de" })).translation?.qa.warnings,
  ).toBe(0);
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
  expect(
    (await service.listComments(ANONYMOUS, { stringId: id })).comments.map((row) => row.id),
  ).toStrictEqual([pending.id]);
  expect(
    sql.query<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM comments WHERE id = ?",
      comment.id,
    )[0].deleted_at !== null,
  ).toBe(true);
  await denied(service.listComments(ANONYMOUS, { sourceIssue: true }), "unauthorized");
  await service.resolveComment(visitor, { id: pending.id });
  expect(
    (await service.listComments(admin, { sourceIssue: true, resolved: false })).comments.length,
  ).toBe(0);
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
  expect(first.tag).toBe("pt-BR");
  expect(first.votes).toBe(1);
  const again = await service.requestLanguage(visitor, { tag: "pt-BR" });
  expect(again.id).toStrictEqual(first.id);
  expect(again.votes).toBe(1);
  expect((await service.requestLanguage(second, { tag: "pt-br" })).votes).toBe(2);
  await denied(service.reviewLanguageRequest(manager, { id: first.id, action: "approve" }));
  const approved = await service.reviewLanguageRequest(admin, { id: first.id, action: "approve" });
  expect(approved.status).toBe("approved");
  expect((await service.listLanguageRequests(ANONYMOUS, {})).requests.length).toBe(0);
  assert(
    (await service.getProject(ANONYMOUS, {})).languages.some(
      (language) => language.tag === "pt-BR",
    ),
  );
  await denied(
    service.reviewLanguageRequest(admin, { id: first.id, action: "reject" }),
    "conflict",
  );
  await expect(service.requestLanguage(visitor, { tag: "pt-BR" })).rejects.toThrow(ServiceError);
  await denied(service.requestLanguage(visitor, { tag: "en" }), "bad_request");
});
