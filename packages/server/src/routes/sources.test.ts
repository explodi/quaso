// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { SYSTEM } from "@quaso/service";
import { realService } from "../testing/real_service.ts";
import { call, testApp } from "../testing/helpers.ts";

test("source uploads require repository display paths while imports keep identity paths", async () => {
  const real = await realService({ clock: () => 100 });
  try {
    const token = await real.service.createApiToken(SYSTEM, {
      name: "Source test",
      scope: "upload",
    });
    const { app } = testApp(real.service);
    const file = { path: "menu.json", content: '{"play":"Play"}' };
    const missing = await call(app, "/api/v1/sources", {
      method: "POST",
      key: token.secret,
      json: { files: [file] },
    });
    assertEquals(missing.status, 400);
    assertEquals((await missing.json()).error.details, [
      { path: "files[0].repoPath", message: "is required" },
    ]);
    const uploaded = await call(app, "/api/v1/sources", {
      method: "POST",
      key: token.secret,
      json: { files: [{ ...file, repoPath: "src/locales/en/menu.json" }], languages: ["de"] },
    });
    assertEquals(uploaded.status, 200);
    const sourceResponse = await call(app, "/api/v1/files");
    assertEquals(sourceResponse.status, 200);
    const sources = await sourceResponse.json();
    assertEquals(sources, {
      files: [
        {
          id: 1,
          path: "menu.json",
          repoPath: "src/locales/en/menu.json",
          strings: 1,
          words: 1,
          updatedAt: 100,
          revision: 1,
        },
      ],
    });
    const languageResponse = await call(app, "/api/v1/files?language=DE");
    assertEquals(languageResponse.status, 200);
    const language = await languageResponse.json();
    assertEquals(
      [
        language.language,
        language.files[0].path,
        language.files[0].repoPath,
        language.files[0].untranslated,
      ],
      ["de", "menu.json", "src/locales/en/menu.json", 1],
    );
    assertEquals((await call(app, "/api/v1/files?language=fr")).status, 404);
    const imported = await call(app, "/api/v1/imports", {
      method: "POST",
      key: token.secret,
      json: {
        files: [{ path: "menu.json", content: '{"play":"Spielen"}' }],
        language: "de",
        as: "blue",
      },
    });
    assertEquals(imported.status, 200);
    assertEquals(await (await call(app, "/api/v1/files")).json(), sources);
    const strings = await real.service.listStrings(SYSTEM, { language: "de", file: "menu.json" });
    assertEquals(
      [strings.strings[0].file, strings.strings[0].translation?.value],
      ["menu.json", "Spielen"],
    );
  } finally {
    real.close();
  }
});
