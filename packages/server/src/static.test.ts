// SPDX-License-Identifier: MIT
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import { expect, test } from "vitest";
import { join } from "node:path";
import { CONTENT_SECURITY_POLICY } from "./http/headers.ts";
import { FakeService } from "./testing/fake_service.ts";
import { call, testApp } from "./testing/helpers.ts";

const INDEX =
  '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js">' +
  "</script></head><body><div id=root></div></body></html>";

async function withWebsite(fn: (webDir: string) => Promise<void>): Promise<void> {
  const webDir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
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
    expect(response.status).toBe(200);
    expect(await response.text()).toStrictEqual(INDEX);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(response.headers.get("Content-Security-Policy")).toStrictEqual(CONTENT_SECURITY_POLICY);
    expect(response.headers.get("Cache-Control")).toStrictEqual(
      "public, max-age=300, stale-while-revalidate=600",
    );
    const etag = response.headers.get("ETag")!;
    const again = await call(app, "/", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("Cache-Control")).toStrictEqual(
      "public, max-age=300, stale-while-revalidate=600",
    );
  }));

test("website: hashed build files are immutable", () =>
  withWebsite(async (webDir) => {
    const { app } = testApp(new FakeService(), { WEB_DIR: webDir });
    const response = await call(app, "/assets/index-abc123.js");
    expect(await response.text()).toBe("console.log('hi');");
    expect(response.headers.get("Content-Type")!).toContain("javascript");
    expect(response.headers.get("Cache-Control")).toStrictEqual(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(null);
    const icon = await call(app, "/favicon.svg");
    await icon.body?.cancel();
    expect(icon.headers.get("Cache-Control")).toStrictEqual(
      "public, max-age=300, stale-while-revalidate=600",
    );
  }));

test("website: other pages get index.html, but not missing build files or the API", () =>
  withWebsite(async (webDir) => {
    const { app } = testApp(new FakeService(), { WEB_DIR: webDir });
    for (const path of ["/strings/5?language=de", "/settings/api-keys", "/de/common.json"]) {
      const page = await call(app, path);
      expect(page.status, path).toBe(200);
      expect(await page.text()).toStrictEqual(INDEX);
    }
    const missing = await call(app, "/assets/index-old999.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("private, no-store");
    await missing.body?.cancel();
    for (const path of ["/api/v1/missing", "/auth/callback", "/healthz/x", "/schema/other.json"]) {
      const response = await call(app, path);
      expect(response.status, path).toBe(404);
      expect((await response.json()).error.code).toBe("not_found");
    }
    const post = await call(app, "/settings", { method: "POST" });
    expect(post.status).toBe(405);
    await post.body?.cancel();
    const head = await call(app, "/", { method: "HEAD" });
    expect([head.status, head.body]).toStrictEqual([200, null]);
  }));

test("website: a path that can't be decoded is a 400, not a server error", () =>
  withWebsite(async (webDir) => {
    const { app, log } = testApp(new FakeService(), { WEB_DIR: webDir });
    for (const path of ["/%E0%A4%A", "/%00", "/editor/%ff", "/assets/%ff.js"]) {
      const response = await call(app, path);
      expect(response.status, path).toBe(400);
      expect((await response.json()).error.code).toBe("bad_request");
    }
    expect(log.lines.filter((line) => line.level === "error")).toStrictEqual([]);
    const encoded = await call(app, "/strings/caf%C3%A9");
    expect([encoded.status, await encoded.text()]).toStrictEqual([200, INDEX]);
  }));

test("website: without a build, a placeholder says how to make one", async () => {
  const { app } = testApp(new FakeService());
  const response = await call(app, "/");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("npm run build:web");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Security-Policy")).toStrictEqual(CONTENT_SECURITY_POLICY);
});
