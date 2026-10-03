// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import type { StringsQueue } from "@quaso/core";
import { SYSTEM } from "@quaso/service";
import { realService } from "../testing/real_service.ts";
import { call, testApp } from "../testing/helpers.ts";

test("string queue route is public, filters folders and validates its query", async () => {
  const real = await realService();
  try {
    await real.service.upload(SYSTEM, {
      files: [
        { path: "menu/play.json", repoPath: "menu/play.json", content: '{"play":"Play"}' },
        { path: "other.json", repoPath: "other.json", content: '{"other":"Other"}' },
      ],
      languages: ["de"],
    });
    const { app } = testApp(real.service);
    const response = await call(app, "/api/v1/strings/queue?language=de&file=menu/");
    assertEquals(response.status, 200);
    const queue = (await response.json()) as StringsQueue;
    assertEquals([queue.language, queue.toDo, queue.ids.length], ["de", 1, 1]);
    const detail = await real.service.getString(SYSTEM, { id: queue.ids[0], language: "de" });
    assertEquals(detail.file, "menu/play.json");
    assertEquals((await call(app, "/api/v1/strings/queue")).status, 400);
    assertEquals((await call(app, "/api/v1/strings/queue?language=es")).status, 404);
  } finally {
    real.close();
  }
});
