// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
/**
 * The server with the real service on an in-memory database, through `createApp`, without
 * a network: the CLI's calls, anonymous reads, and acceptance tests 2 and 7 through the API.
 */
import type { StatusResult, StringsPage } from "@quaso/core";
import { DATABASE_VERSION, type Service, SYSTEM } from "@quaso/service";
import { type App } from "./app.ts";
import { demoDir, readProjectFiles } from "./dev_seed.ts";
import { realService } from "./testing/real_service.ts";
import { call, testApp } from "./testing/helpers.ts";

const LANGUAGES = ["de", "fr", "pl", "ja", "ar", "pt-BR"];

interface Setup {
  app: App;
  service: Service;
  upload: string;
  read: string;
}

function integration(name: string, fn: (setup: Setup) => Promise<void>): void {
  test(`integration: ${name}`, {}, async () => {
    const real = await realService();
    try {
      const upload = await real.service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
      const read = await real.service.createApiToken(SYSTEM, { name: "Read", scope: "read" });
      const { app } = testApp(real.service);
      await fn({ app, service: real.service, upload: upload.secret, read: read.secret });
    } finally {
      real.close();
    }
  });
}

/** The demo's English files, as `quaso upload` sends them. */
async function uploadBody() {
  const { config, sources } = await readProjectFiles(demoDir());
  return {
    files: sources,
    sourceLanguage: config.sourceLanguage,
    languages: config.languages,
    limits: config.limits,
  };
}

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toStrictEqual(status);
  return body;
}

integration("/healthz reports the schema version", async ({ app }) => {
  const health = await json<Record<string, unknown>>(call(app, "/healthz"));
  expect(health.ok).toBe(true);
  expect(health.schemaVersion).toStrictEqual(DATABASE_VERSION);
});

integration("an upload needs an API key with the upload scope", async ({ app, upload, read }) => {
  const body = await uploadBody();
  const anonymous = await json<{ error: { code: string } }>(
    call(app, "/api/v1/sources", { method: "POST", json: body }),
    401,
  );
  expect(anonymous.error.code).toBe("unauthorized");
  await json(call(app, "/api/v1/sources", { method: "POST", json: body, key: read }), 403);
  const result = await json<{ files: { path: string; status: string }[] }>(
    call(app, "/api/v1/sources", { method: "POST", json: body, key: upload }),
  );
  expect(result.files.map((f) => [f.path, f.status])).toStrictEqual([
    ["common.json", "new"],
    ["menus.json", "new"],
    ["store.json", "new"],
  ]);
});

integration("anyone reads the project, with each language's plural categories", async (s) => {
  await json(
    call(s.app, "/api/v1/sources", { method: "POST", json: await uploadBody(), key: s.upload }),
  );
  const response = await call(s.app, "/api/v1/project");
  expect(response.headers.get("Cache-Control")).toStrictEqual(
    "public, max-age=30, stale-while-revalidate=300",
  );
  const project = await response.json();
  expect(project.languages.map((l: { tag: string }) => l.tag).sort()).toStrictEqual(
    [...LANGUAGES].sort(),
  );
  const polish = project.languages.find((l: { tag: string }) => l.tag === "pl");
  expect(polish.plural).toStrictEqual({
    cardinal: ["one", "few", "many", "other"],
    ordinal: ["other"],
  });
  const files = await json<{ files: { path: string }[] }>(call(s.app, "/api/v1/files?language=de"));
  expect(files.files.map((f) => f.path)).toStrictEqual(["common.json", "menus.json", "store.json"]);
  const activity = await json<{ items: unknown[] }>(call(s.app, "/api/v1/activity"));
  assert(activity.items.length > 0);
});

integration("a download needs an API key", async ({ app, upload, read }) => {
  await json(
    call(app, "/api/v1/sources", { method: "POST", json: await uploadBody(), key: upload }),
  );
  await json(call(app, "/api/v1/export"), 401);
  for (const key of [read, upload]) {
    const result = await json<{ files: { path: string; language: string }[] }>(
      call(app, "/api/v1/export?languages=de,ja&files=common.json", { key }),
    );
    expect(result.files.map((f) => `${f.language}/${f.path}`).sort()).toStrictEqual([
      "de/common.json",
      "ja/common.json",
    ]);
  }
});

integration("a download is gzip-compressed for clients that accept it", async (s) => {
  await json(
    call(s.app, "/api/v1/sources", { method: "POST", json: await uploadBody(), key: s.upload }),
  );
  const plain = await call(s.app, "/api/v1/export", { key: s.read });
  const expected = await plain.text();
  expect(plain.headers.get("Content-Encoding")).toBe(null);
  const response = await call(s.app, "/api/v1/export", {
    key: s.read,
    headers: { "Accept-Encoding": "gzip, br" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Encoding")).toBe("gzip");
  expect(response.headers.get("Vary")).toBe("Authorization, Cookie, Accept-Encoding");
  const compressed = new Uint8Array(await response.arrayBuffer());
  assert(compressed.length < expected.length / 2, `${compressed.length} of ${expected.length}`);
  const text = await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
  expect(text).toStrictEqual(expected);
  expect(JSON.parse(text).files.length).toStrictEqual(LANGUAGES.length * 3);
});

integration(
  "acceptance test 2: after an upload, every string is red in every language",
  async (s) => {
    await json(
      call(s.app, "/api/v1/sources", { method: "POST", json: await uploadBody(), key: s.upload }),
    );
    await json(call(s.app, "/api/v1/status"), 401);
    const status = await json<StatusResult>(call(s.app, "/api/v1/status", { key: s.read }));
    expect(status.languages.map((l) => l.tag).sort()).toStrictEqual([...LANGUAGES].sort());
    for (const language of status.languages) {
      expect(language.strings, language.tag).toBe(40);
      expect(language.untranslated, language.tag).toStrictEqual(language.strings);
      expect(language.green + language.blue, language.tag).toBe(0);
    }
    for (const language of LANGUAGES) {
      const page = await json<StringsPage>(
        call(s.app, `/api/v1/strings?language=${language}&limit=500`),
      );
      expect(page.total).toBe(40);
      expect(page.strings.length).toBe(40);
      assert(
        page.strings.every((string) => string.translation === null),
        language,
      );
      const red = await json<StringsPage>(
        call(s.app, `/api/v1/strings?language=${language}&state=untranslated&limit=1`),
      );
      expect(red.total).toBe(40);
    }
  },
);

integration(
  "acceptance test 7: changed English leaves the old translation, outdated",
  async (s) => {
    const body = await uploadBody();
    await json(call(s.app, "/api/v1/sources", { method: "POST", json: body, key: s.upload }));
    const german = { play: "Spielen" };
    await json(
      call(s.app, "/api/v1/imports", {
        method: "POST",
        key: s.upload,
        json: {
          language: "de",
          as: "green",
          files: [{ path: "common.json", content: JSON.stringify(german) }],
        },
      }),
    );

    const changed = structuredClone(body);
    const common = changed.files.find((file) => file.path === "common.json")!;
    common.content = common.content.replace('"play": "Play"', '"play": "Play now"');
    const result = await json<{ changed: { key: string }[] }>(
      call(s.app, "/api/v1/sources", { method: "POST", json: changed, key: s.upload }),
    );
    expect(result.changed.map((ref) => ref.key)).toStrictEqual(["play"]);

    const page = await json<StringsPage>(call(s.app, "/api/v1/strings?language=de&q=Play now"));
    const play = page.strings.find((string) => string.key === "play")!;
    expect(play.source).toBe("Play now");
    expect(play.translation?.value).toBe("Spielen");
    expect(play.translation?.outdated).toBe(true);
    const outdated = await json<StringsPage>(
      call(s.app, "/api/v1/strings?language=de&state=outdated"),
    );
    expect(outdated.strings.map((string) => string.key)).toStrictEqual(["play"]);

    const exported = await json<{ files: { content: string }[] }>(
      call(s.app, "/api/v1/export?languages=de&files=common.json", { key: s.read }),
    );
    expect(exported.files[0].content).toContain('"play": "Spielen"');
    const history = await json<{ entries: { event: string }[] }>(
      call(s.app, `/api/v1/strings/${play.id}/history`),
    );
    assert(history.entries.some((entry) => entry.event === "source_changed"));
    const detail = await json<{ translation: { outdated: boolean } }>(
      call(s.app, `/api/v1/strings/${play.id}?language=de`),
    );
    expect(detail.translation.outdated).toBe(true);

    // Until it is updated: a new translation is current again, and downloaded instead.
    await json(
      call(s.app, "/api/v1/imports", {
        method: "POST",
        key: s.upload,
        json: {
          language: "de",
          as: "green",
          files: [{ path: "common.json", content: JSON.stringify({ play: "Jetzt spielen" }) }],
        },
      }),
    );
    const updated = await json<StringsPage>(
      call(s.app, "/api/v1/strings?language=de&state=outdated"),
    );
    expect(updated.total).toBe(0);
    const again = await json<{ files: { content: string }[] }>(
      call(s.app, "/api/v1/export?languages=de&files=common.json", { key: s.read }),
    );
    expect(again.files[0].content).toContain('"play": "Jetzt spielen"');
  },
);

integration("API keys: only administrators manage them; a revoked key stops", async (s) => {
  const denied = await json<{ error: { code: string } }>(
    call(s.app, "/api/v1/api-tokens", { key: s.upload }),
    403,
  );
  expect(denied.error.code).toBe("forbidden");
  await json(call(s.app, "/api/v1/api-tokens"), 401);
  const { tokens } = await s.service.listApiTokens(SYSTEM, {});
  const read = tokens.find((token) => token.name === "Read")!;
  await json(call(s.app, "/api/v1/status", { key: s.read }));
  await s.service.revokeApiToken(SYSTEM, { id: read.id });
  // This server's cache still knows the key, but the service checks the key again on
  // every call and refuses it; the server then checks it again, and answers 401.
  const revoked = await json<{ error: { message: string } }>(
    call(s.app, "/api/v1/export", { key: s.read }),
    401,
  );
  expect(revoked.error.message).toBe("This API key is unknown or was revoked.");
  // A server without the key in its cache refuses it at once too.
  const { app: fresh } = testApp(s.service);
  await json(call(fresh, "/api/v1/status", { key: s.read }), 401);
});
