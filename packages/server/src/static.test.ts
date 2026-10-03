// SPDX-License-Identifier: MIT
import { makeTempDir } from "@quaso/runtime/files";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "@quaso/runtime/assert";
import { join } from "node:path";
import { CONTENT_SECURITY_POLICY } from "./http/headers.ts";
import { FakeService } from "./testing/fake_service.ts";
import { call, testApp } from "./testing/helpers.ts";

const INDEX =
  '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js">' +
  "</script></head><body><div id=root></div></body></html>";

async function withWebsite(fn: (webDir: string) => Promise<void>): Promise<void> {
  const webDir = await makeTempDir();
  try {
    await fs.mkdir(join(webDir, "assets"));
    await fs.writeFile(join(webDir, "index.html"), INDEX);
    await fs.writeFile(join(webDir, "assets", "index-abc123.js"), "console.log('hi');");
    await fs.writeFile(join(webDir, "favicon.svg"), "<svg></svg>");
    await fn(webDir);
  } finally {
    await fs.rm(webDir, { recursive: true });
  }
}

test("website: the HTML shell, with the CSP, for a few minutes", () =>
  withWebsite(async (webDir) => {
    const { app } = testApp(new FakeService(), { WEB_DIR: webDir });
    const response = await call(app, "/");
    assertEquals(response.status, 200);
    assertEquals(await response.text(), INDEX);
    assertEquals(response.headers.get("Content-Type"), "text/html;charset=utf-8");
    assertEquals(response.headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
    assertEquals(
      response.headers.get("Cache-Control"),
      "public, max-age=300, stale-while-revalidate=600",
    );
    const etag = response.headers.get("ETag")!;
    const again = await call(app, "/", { headers: { "If-None-Match": etag } });
    assertEquals(again.status, 304);
    assertEquals(
      again.headers.get("Cache-Control"),
      "public, max-age=300, stale-while-revalidate=600",
    );
  }));

test("website: hashed build files are immutable", () =>
  withWebsite(async (webDir) => {
    const { app } = testApp(new FakeService(), { WEB_DIR: webDir });
    const response = await call(app, "/assets/index-abc123.js");
    assertEquals(await response.text(), "console.log('hi');");
    assertStringIncludes(response.headers.get("Content-Type")!, "javascript");
    assertEquals(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assertEquals(response.headers.get("Content-Security-Policy"), null);
    const icon = await call(app, "/favicon.svg");
    await icon.body?.cancel();
    assertEquals(
      icon.headers.get("Cache-Control"),
      "public, max-age=300, stale-while-revalidate=600",
    );
  }));

test("website: other pages get index.html, but not missing build files or the API", () =>
  withWebsite(async (webDir) => {
    const { app } = testApp(new FakeService(), { WEB_DIR: webDir });
    for (const path of ["/strings/5?language=de", "/settings/api-keys", "/de/common.json"]) {
      const page = await call(app, path);
      assertEquals(page.status, 200, path);
      assertEquals(await page.text(), INDEX);
    }
    const missing = await call(app, "/assets/index-old999.js");
    assertEquals(missing.status, 404);
    assertEquals(missing.headers.get("Cache-Control"), "private, no-store");
    await missing.body?.cancel();
    for (const path of ["/api/v1/missing", "/auth/callback", "/healthz/x", "/schema/other.json"]) {
      const response = await call(app, path);
      assertEquals(response.status, 404, path);
      assertEquals((await response.json()).error.code, "not_found");
    }
    const post = await call(app, "/settings", { method: "POST" });
    assertEquals(post.status, 405);
    await post.body?.cancel();
    const head = await call(app, "/", { method: "HEAD" });
    assertEquals([head.status, head.body], [200, null]);
  }));

test("website: a path that can't be decoded is a 400, not a server error", () =>
  withWebsite(async (webDir) => {
    const { app, log } = testApp(new FakeService(), { WEB_DIR: webDir });
    for (const path of ["/%E0%A4%A", "/%00", "/editor/%ff", "/assets/%ff.js"]) {
      const response = await call(app, path);
      assertEquals(response.status, 400, path);
      assertEquals((await response.json()).error.code, "bad_request");
    }
    assertEquals(
      log.lines.filter((line) => line.level === "error"),
      [],
    );
    const encoded = await call(app, "/strings/caf%C3%A9");
    assertEquals([encoded.status, await encoded.text()], [200, INDEX]);
  }));

test("website: without a build, a placeholder says how to make one", async () => {
  const { app } = testApp(new FakeService());
  const response = await call(app, "/");
  assertEquals(response.status, 200);
  assertStringIncludes(await response.text(), "bun run build:web");
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  assertEquals(response.headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
});
