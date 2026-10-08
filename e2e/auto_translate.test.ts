// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { CreateJobResult, JobInfo, JobsResult } from "@quaso/core";
import { ANONYMOUS, createFakeTranslator, SYSTEM, type Service } from "@quaso/service";
import type { Page } from "puppeteer";
import { browserTest, openTab, press, text, waitFor } from "./_setup.ts";

const EMAIL = "auto@example.com";
const PASSWORD = "a long test password";

async function prepare(service: Service) {
  const setup = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: setup.token!,
    email: EMAIL,
    password: PASSWORD,
    displayName: "Auto Owner",
    projectName: "Auto test",
  });
  await service.updateSettings(SYSTEM, {
    llm: { autoTranslate: false, context: { fileContext: false, otherLanguages: ["fr"] } },
  });
  await service.upload(SYSTEM, {
    sourceLanguage: "en",
    languages: ["de", "fr"],
    files: [
      {
        path: "common.json",
        repoPath: "src/locales/en/common.json",
        content: '{"hello":"Hello there"}',
      },
      {
        path: "menus/play.json",
        repoPath: "src/locales/en/menus/play.json",
        content: '{"play":"Play now"}',
      },
      {
        path: "menus/quit.json",
        repoPath: "src/locales/en/menus/quit.json",
        content: '{"quit":"Quit the game"}',
      },
    ],
  });
}

async function signIn(page: Page) {
  await page.evaluate(
    async (email, password) => {
      const response = await fetch("/api/v1/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error(`Sign-in ${response.status}`);
    },
    EMAIL,
    PASSWORD,
  );
}

async function clickButton(page: Page, label: string) {
  await page.evaluate((label) => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === label)!
      .click();
  }, label);
}

async function ready(page: Page) {
  await waitFor(page, () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].some(
      (button) => button.textContent?.trim() === "Start translation" && !button.disabled,
    ),
  );
}

browserTest(
  "auto-translate selects repository folders, announces mixed states and creates the exact scope",
  {
    prepare,
    serviceOptions: { provider: createFakeTranslator() },
  },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/signin");
    await signIn(page);
    await page.goto(server.url, { waitUntil: "networkidle0" });
    await clickButton(page, "Auto-translate");
    await ready(page);
    assertStringIncludes(
      await text(page, ".reference-languages"),
      "French (proofread strings marked)",
    );
    assertEquals(
      await page.$eval(".reference-languages a", (link) => link.getAttribute("href")),
      "/settings?section=llm#reference-languages",
    );
    assertStringIncludes(await text(page, ".estimate-languages"), "German: 3 strings · 7 words");
    assertStringIncludes(await text(page, ".estimate-languages"), "French: 3 strings · 7 words");
    const root = '[role="tree"][aria-label="Files to translate"] [data-path=""]';
    await page.focus(root);
    await press(page, " ");
    assertEquals(await page.$eval(root, (node) => node.getAttribute("aria-checked")), "false");
    await press(page, "ArrowDown");
    await waitFor(page, () => document.activeElement?.getAttribute("data-path") === "src/");
    assertEquals(
      await page.evaluate(() => document.activeElement?.getAttribute("data-path")),
      "src/",
    );
    await press(page, "ArrowLeft");
    await waitFor(page, () => document.activeElement?.getAttribute("aria-expanded") === "false");
    assertEquals(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-expanded")),
      "false",
    );
    await press(page, "ArrowLeft");
    await waitFor(page, () => document.activeElement?.getAttribute("data-path") === "");
    assertEquals(await page.evaluate(() => document.activeElement?.getAttribute("data-path")), "");
    await press(page, "ArrowRight");
    await waitFor(page, () => document.activeElement?.getAttribute("data-path") === "src/");
    await press(page, "ArrowRight");
    await waitFor(page, () => document.activeElement?.getAttribute("aria-expanded") === "true");
    await page.focus('[data-path="src/locales/en/menus/"]');
    await press(page, " ");
    assertEquals(
      await page.$eval('[data-path="src/locales/en/menus/"]', (node) =>
        node.getAttribute("aria-checked"),
      ),
      "true",
    );
    await press(page, "End");
    await waitFor(page, () => document.activeElement?.getAttribute("data-path") === "common.json");
    assertEquals(
      await page.evaluate(() => document.activeElement?.getAttribute("data-path")),
      "common.json",
    );
    await page.focus('[data-path="menus/quit.json"]');
    await press(page, " ");
    assertEquals(
      await page.$eval('[data-path="src/locales/en/menus/"]', (node) =>
        node.getAttribute("aria-checked"),
      ),
      "mixed",
    );
    assertEquals(await page.$eval(root, (node) => node.getAttribute("aria-checked")), "mixed");
    await ready(page);
    const dry = await server.api<CreateJobResult>("/jobs", {
      method: "POST",
      body: JSON.stringify({
        dryRun: true,
        files: ["menus/play.json"],
        retranslate: false,
        outdated: true,
      }),
    });
    assertEquals(dry.estimate?.files, [{ file: "menus/play.json", strings: 2, words: 4 }]);
    assertEquals(
      await text(page, '[data-path="menus/play.json"] > .tree-row .tree-stats'),
      "4 words to translate",
    );
    assertEquals(
      await text(page, '[data-path="src/locales/en/menus/"] > .tree-row .tree-stats'),
      "4 words to translate",
    );
    assertEquals(
      await text(page, '[data-path="menus/quit.json"] > .tree-row .tree-stats'),
      "0 words to translate",
    );
    const cdp = await page.createCDPSession();
    const accessibility = await cdp.send("Accessibility.getFullAXTree");
    const mixed = accessibility.nodes.find(
      (node) =>
        node.role?.value === "treeitem" &&
        node.properties?.some(
          (property) => property.name === "checked" && property.value.value === "mixed",
        ),
    );
    assert(mixed);
    await cdp.detach();
    await page.screenshot({ path: "/private/tmp/quaso-auto-desktop.png" });
    await page.setViewport({ width: 360, height: 800 });
    assert(await page.$eval("dialog", (dialog) => dialog.scrollWidth <= dialog.clientWidth));
    await page.screenshot({ path: "/private/tmp/quaso-auto-mobile.png" });
    await clickButton(page, "Start translation");
    await waitFor(page, () => document.querySelector("dialog[open]") === null);
    const job = await page.evaluate(async () => {
      const jobs = (await fetch("/api/v1/jobs").then((response) => response.json())) as JobsResult;
      return (await fetch(`/api/v1/jobs/${jobs.jobs[0].id}`).then((response) =>
        response.json(),
      )) as JobInfo;
    });
    assertEquals(job.scope.files, ["menus/play.json"]);
    assertEquals(job.progress.total, 2);
    assertEquals(problems, []);
  },
);

browserTest(
  "auto-translate defaults follow the language and editor file or folder",
  {
    prepare,
    serviceOptions: { provider: createFakeTranslator() },
  },
  async ({ server, browser }) => {
    await server.service.updateSettings(SYSTEM, { llm: { context: { otherLanguages: [] } } });
    const { page, problems } = await openTab(browser, server, "/signin");
    await signIn(page);
    await page.goto(`${server.url}/languages/fr`, { waitUntil: "networkidle0" });
    await clickButton(page, "Auto-translate");
    await ready(page);
    assertStringIncludes(await text(page, ".reference-languages"), "No reference languages.");
    assertEquals(await text(page, ".estimate-languages"), "French: 3 strings · 7 words");
    assertEquals(
      await page.$eval('[data-path=""]', (node) => node.getAttribute("aria-checked")),
      "true",
    );
    await press(page, "Escape");
    await page.goto(`${server.url}/translate/fr?file=menus/play.json`, {
      waitUntil: "networkidle0",
    });
    await clickButton(page, "Auto-translate");
    await ready(page);
    assertEquals(
      await page.$eval('dialog[open] [data-path="menus/play.json"]', (node) =>
        node.getAttribute("aria-checked"),
      ),
      "true",
    );
    assertEquals(
      await page.$eval('dialog[open] [data-path="menus/quit.json"]', (node) =>
        node.getAttribute("aria-checked"),
      ),
      "false",
    );
    assertEquals(await text(page, ".estimate-languages"), "French: 1 string · 2 words");
    await press(page, "Escape");
    await page.goto(`${server.url}/translate/fr?file=menus/`, { waitUntil: "networkidle0" });
    await clickButton(page, "Auto-translate");
    await ready(page);
    assertEquals(
      await page.$eval('dialog[open] [data-path="src/locales/en/menus/"]', (node) =>
        node.getAttribute("aria-checked"),
      ),
      "true",
    );
    assertEquals(await text(page, ".estimate-languages"), "French: 2 strings · 5 words");
    await page.click(".reference-languages a");
    await waitFor(
      page,
      () =>
        location.pathname === "/settings" &&
        document.querySelector("#reference-languages") !== null,
    );
    assertEquals(
      await page.$eval("main select", (select) => (select as HTMLSelectElement).value),
      "llm",
    );
    assertEquals(problems, []);
  },
);
