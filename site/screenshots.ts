// SPDX-License-Identifier: MIT
import { serveHttp } from "@quaso/runtime/http";
import * as fs from "node:fs/promises";
/** Capture the real seeded app with Puppeteer: bun run site/screenshots.ts. */
import { ANONYMOUS, SYSTEM } from "@quaso/service";
import { fileURLToPath as fromFileUrl } from "node:url";
import { ensureWebsiteBuilt, openBrowser, waitFor, WEB_DIST } from "../e2e/_setup.ts";
import { type App, createApp } from "../packages/server/src/app.ts";
import { demoDir, seedDemo } from "../packages/server/src/dev_seed.ts";
import { memoryLogger, testConfig } from "../packages/server/src/testing/helpers.ts";
import { realService } from "../packages/server/src/testing/real_service.ts";

await ensureWebsiteBuilt();
const real = await realService({ dev: true });
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
let app: App;
const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) =>
  app(request),
);
const url = `http://127.0.0.1:${server.addr.port}`;
const directory = fromFileUrl(new URL("./public/screenshots/", import.meta.url));
try {
  // Screenshots show a settled workspace without a queued automatic job obscuring it.
  await real.service.updateSettings(SYSTEM, { llm: { autoTranslate: false } });
  await seedDemo(real.service, demoDir(), { people: true });
  await real.service.updateSettings(SYSTEM, {
    name: "Demo project",
    description:
      "Help translate the demo into your language. Review a suggestion or proofread a string.",
  });
  app = createApp({
    config: testConfig({ QUASO_DEV: "1", PUBLIC_URL: url, WEB_DIR: WEB_DIST }),
    service: real.service,
    log: memoryLogger(),
  });
  await fs.mkdir(directory, { recursive: true });
  const strings = await real.service.listStrings(ANONYMOUS, {
    language: "pl",
    file: "common.json",
    limit: 500,
  });
  const plural = strings.strings.find((string) => string.key === "coins");
  if (!plural) throw new Error("The demo has no coins plural");
  const editor = `/translate/pl?file=common.json&id=${plural.id}`;
  const views = [
    { name: "dashboard", path: "/", theme: "light", ready: "Polish" },
    { name: "editor-pl", path: editor, theme: "light", ready: "moneta" },
    { name: "editor-dark", path: editor, theme: "dark", ready: "moneta" },
    { name: "review", path: "/review", theme: "light", ready: "Commencer une nouvelle partie" },
  ];
  for (const view of views) {
    // A separate browser for each capture keeps the renderer and viewport independent.
    browser = await openBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 960 });
    const protocol = await page.createCDPSession();
    await protocol.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluateOnNewDocument((theme) => {
      localStorage.setItem("quaso.theme", theme);
    }, view.theme);
    const problems: string[] = [];
    page.on("pageerror", (event) => problems.push(String(event)));
    await page.goto(`${url}/auth/dev-login`, { waitUntil: "networkidle0" });
    if (view.path !== "/") await page.goto(`${url}${view.path}`, { waitUntil: "networkidle0" });
    await waitFor(
      page,
      (ready: string) => {
        const values = [...document.querySelectorAll("textarea")]
          .map((input) => input.value)
          .join(" ");
        return (document.querySelector("main")?.textContent + " " + values).includes(ready);
      },
      [view.ready],
    );
    await page.evaluate(() => document.fonts.ready);
    if (problems.length) throw new Error(problems.join("\n"));
    await fs.writeFile(
      `${directory}/${view.name}.png`,
      await page.screenshot({
        type: "png",
        captureBeyondViewport: false,
        fromSurface: true,
      }),
    );
    console.log(`Captured ${view.name}.png`);
    await browser.close();
    browser = undefined;
  }
} finally {
  await browser?.close();
  await server.shutdown();
  real.close();
}
