// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { assert, expect, test } from "vitest";
/** Public routes with the real service: input validation, access, limits and human checks. */
import { type Actor, ANONYMOUS, SYSTEM } from "@quaso/service";
import {
  addUser,
  startTestService,
  stringId,
  uploadJson,
} from "../../../service/src/test_helpers.ts";
import { createApp } from "../app.ts";
import { RATE_RULES } from "../rate_limit.ts";
import { call, memoryLogger, testConfig } from "../testing/helpers.ts";

test("community routes: glossary CRUD, comments and language approval", async () => {
  using t = await startTestService();
  await t.service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
  await uploadJson(t.service, { "common.json": { title: "Play Quaso" } }, { languages: ["de"] });
  const id = stringId(t.sql, "common.json", "title");
  const actors: Record<string, Actor> = {
    admin: addUser(t.sql, "administrator"),
    contributor: addUser(t.sql, "contributor"),
  };
  const app = createApp({
    config: testConfig(),
    service: t.service,
    log: memoryLogger(),
    auth: {
      actorFor: (request) =>
        Promise.resolve(
          actors[request.headers.get("Authorization")?.replace("Bearer ", "") ?? ""] ?? ANONYMOUS,
        ),
      recheck: () => Promise.resolve(),
      forget: () => {},
      scopeOf: () => null,
    },
  });
  const request = (path: string, method = "GET", json?: unknown, key?: string) =>
    call(app, "/api/v1" + path, { method, json, key });
  expect((await request("/glossary")).status).toBe(200);
  expect((await request("/glossary", "POST", { term: "Quaso", kind: "keep" })).status).toBe(401);
  const created = await request("/glossary", "POST", { term: "Quaso", kind: "keep" }, "admin");
  expect(created.status).toBe(201);
  const term = await created.json();
  expect((await request(`/glossary/${term.id}`, "PATCH", { note: "Brand" }, "admin")).status).toBe(
    200,
  );
  expect((await (await request("/glossary?q=brand")).json()).terms.length).toBe(1);
  expect((await request(`/glossary/${term.id}`, "DELETE", undefined, "admin")).status).toBe(200);
  const comment = await request(
    `/strings/${id}/comments`,
    "POST",
    {
      body: "Meaning is unclear",
      sourceIssue: true,
    },
    "contributor",
  );
  expect(comment.status).toBe(201);
  const note = await comment.json();
  expect((await (await request(`/strings/${id}/comments`)).json()).comments[0].id).toStrictEqual(
    note.id,
  );
  expect((await request("/comments?sourceIssue=true&resolved=false")).status).toBe(401);
  expect(
    (
      await (
        await request("/comments?sourceIssue=true&resolved=false", "GET", undefined, "admin")
      ).json()
    ).comments.length,
  ).toBe(1);
  expect(
    (await request(`/comments/${note.id}/resolve`, "POST", undefined, "contributor")).status,
  ).toBe(200);
  expect((await request(`/comments/${note.id}`, "DELETE", undefined, "contributor")).status).toBe(
    200,
  );
  expect(
    (await request("/language-requests", "POST", { tag: "not a tag" }, "contributor")).status,
  ).toBe(400);
  const pending = await request(
    "/language-requests",
    "POST",
    { tag: "pt-br", message: "Please" },
    "contributor",
  );
  expect(pending.status).toBe(201);
  const language = await pending.json();
  expect(
    (
      await request(
        `/language-requests/${language.id}/review`,
        "POST",
        { action: "approve" },
        "contributor",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        `/language-requests/${language.id}/review`,
        "POST",
        { action: "approve" },
        "admin",
      )
    ).status,
  ).toBe(200);
  expect((await (await request("/language-requests")).json()).requests).toStrictEqual([]);
  assert(
    (await t.service.getProject(SYSTEM, {})).languages.some((language) => language.tag === "pt-BR"),
  );
});

test("community routes: creation shares per-user rate limits and returns Retry-After", async () => {
  using t = await startTestService();
  await t.service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
  await uploadJson(t.service, { "common.json": { title: "Play" } });
  const id = stringId(t.sql, "common.json", "title");
  const actor = addUser(t.sql, "contributor");
  const app = createApp({
    config: testConfig(),
    service: t.service,
    log: memoryLogger(),
    now: () => 0,
    auth: {
      actorFor: () => Promise.resolve(actor),
      recheck: () => Promise.resolve(),
      forget: () => {},
      scopeOf: () => null,
    },
  });
  for (let n = 0; n < RATE_RULES.communityPerUser.limit; n++) {
    expect(
      (
        await call(app, `/api/v1/strings/${id}/comments`, {
          method: "POST",
          json: { body: "A note" },
        })
      ).status,
    ).toBe(201);
  }
  const refused = await call(app, "/api/v1/language-requests", {
    method: "POST",
    json: { tag: "fr" },
  });
  expect(refused.status).toBe(429);
  assert(Number(refused.headers.get("Retry-After")) > 0);
  expect((await t.service.listLanguageRequests(ANONYMOUS, {})).requests).toStrictEqual([]);
});

test("language request route: optional human check runs before a request is stored", async () => {
  using t = await startTestService();
  await t.service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
  const actor = addUser(t.sql, "none");
  const checked: string[] = [];
  const app = createApp({
    config: testConfig({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" }),
    service: t.service,
    log: memoryLogger(),
    auth: {
      actorFor: () => Promise.resolve(actor),
      recheck: () => Promise.resolve(),
      forget: () => {},
      scopeOf: () => null,
    },
    fetch: ((_url: RequestInfo | URL, init?: RequestInit) => {
      const token = new URLSearchParams(String(init?.body)).get("response")!;
      checked.push(token);
      return Promise.resolve(Response.json({ success: token === "human" }));
    }) as Fetch,
  });
  const post = (humanCheck?: string) =>
    call(app, "/api/v1/language-requests", { method: "POST", json: { tag: "fr", humanCheck } });
  expect((await post()).status).toBe(400);
  expect((await post("bot")).status).toBe(400);
  expect((await t.service.listLanguageRequests(ANONYMOUS, {})).requests).toStrictEqual([]);
  expect((await post("human")).status).toBe(201);
  expect(checked).toStrictEqual(["bot", "human"]);
});
