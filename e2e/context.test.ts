// SPDX-License-Identifier: MIT
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "puppeteer";
import { assert, expect } from "vitest";
import { ANONYMOUS, type Service, SYSTEM } from "@quaso/service";
import { browserTest, openTab, press, text, waitFor } from "./_setup.ts";

const EMAIL = "context-owner@example.com";
const PASSWORD = "context browser test password";

async function prepare(service: Service) {
  const { token } = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: token!,
    email: EMAIL,
    password: PASSWORD,
    displayName: "Context Owner",
    projectName: "Context Project",
  });
  await service.updateSettings(SYSTEM, { llm: { autoTranslate: false } });
  await service.upload(SYSTEM, {
    sourceLanguage: "en",
    languages: ["de"],
    folderContexts: [
      { path: "", context: "Write for the city's residents." },
      { path: "newspaper", context: "Use a lively newspaper voice." },
      { path: "newspaper/crime", context: "Report allegations without presuming guilt." },
      { path: "newspaper/crimewave", context: "This sibling context must stay separate." },
    ],
    files: [
      {
        path: "newspaper/crime/theft.json",
        repoPath: "src/locales/en/newspaper/crime/theft.json",
        content: '{"headline":"Bicycle stolen"}',
        context: "The repository describes a stolen bicycle.",
      },
      {
        path: "newspaper/crimewave/report.json",
        repoPath: "src/locales/en/newspaper/crimewave/report.json",
        content: '{"headline":"Crime wave"}',
      },
    ],
  });
}

async function fill(page: Page, selector: string, value: string) {
  await page.locator(selector).wait();
  await page.$eval(selector, (field) => {
    const input = field as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    input.select();
  });
  await press(page, "Backspace");
  await page.keyboard.type(value);
}

async function signIn(page: Page) {
  await fill(page, "::-p-aria(Email address)", EMAIL);
  await fill(page, "::-p-aria(Password)", PASSWORD);
  await press(page, "Enter");
  await waitFor(page, () => document.querySelector(".user-name") !== null);
}

async function selectScope(page: Page, scope: string) {
  await page.click(`[data-scope="${scope}"]`);
  await waitFor(page, (scope) => new URLSearchParams(location.search).get("scope") === scope, [
    scope,
  ]);
}

browserTest(
  "context shows ordered inheritance and restores a repository override through a real save",
  { prepare },
  async ({ server, browser }) => {
    const settings = await server.service.getSettings(SYSTEM, {});
    const file = settings.files.find((file) => file.path === "newspaper/crime/theft.json")!;
    await server.service.updateFile(SYSTEM, {
      id: file.id,
      context: "The website describes a missing bicycle.",
    });
    const { page, problems } = await openTab(browser, server, "/signin", (page) =>
      page.setViewport({ width: 1600, height: 1000 }),
    );
    await signIn(page);
    await page.goto(`${server.url}/settings?section=files&scope=file:${file.id}`, {
      waitUntil: "networkidle0",
    });
    expect(await page.$$eval("main textarea", (fields) => fields.length)).toBe(1);
    expect(await page.$eval("main textarea", (field) => field.value)).toBe(
      "The website describes a missing bicycle.",
    );
    await page.locator("::-p-aria(Context read for this file)").click();
    const preview = await page.evaluate(() => {
      const summary = [...document.querySelectorAll("summary")].find(
        (summary) => summary.textContent?.trim() === "Context read for this file",
      );
      return summary?.closest("details")?.textContent ?? "";
    });
    assert(preview.indexOf("Write for the city's residents.") >= 0);
    assert(
      preview.indexOf("Write for the city's residents.") <
        preview.indexOf("Use a lively newspaper voice."),
    );
    assert(
      preview.indexOf("Use a lively newspaper voice.") <
        preview.indexOf("Report allegations without presuming guilt."),
    );
    assert(
      preview.indexOf("Report allegations without presuming guilt.") <
        preview.indexOf("The website describes a missing bicycle."),
    );
    expect(preview).not.toContain("This sibling context must stay separate.");
    expect(preview).not.toContain("The repository describes a stolen bicycle.");
    await fill(page, "::-p-aria(Context for this file)", "");
    await page.locator("::-p-aria(Save context)").click();
    await waitFor(page, () =>
      document.querySelector(".context-save")?.textContent?.includes("Saved."),
    );
    await page.select(".context-filter select", "edited");
    expect(await page.$$eval("[data-scope]", (scopes) => scopes.length)).toBe(1);
    expect(await page.$eval("[data-scope]", (scope) => scope.textContent)).toContain("Edited here");
    expect(
      (await server.service.getSettings(SYSTEM, {})).files.find((item) => item.id === file.id)
        ?.uploadedContext,
    ).toBe("The repository describes a stolen bicycle.");
    await page.locator("::-p-aria(Use the file's text)").click();
    expect(await page.$eval("main textarea", (field) => field.value)).toBe(
      "The repository describes a stolen bicycle.",
    );
    expect(
      (await server.service.getSettings(SYSTEM, {})).files.find((item) => item.id === file.id)
        ?.context,
    ).toBe("");
    await page.locator("::-p-aria(Save context)").click();
    await waitFor(page, () => document.querySelector("main")?.textContent?.includes("Saved."));
    expect(
      (await server.service.getSettings(SYSTEM, {})).files.find((item) => item.id === file.id)
        ?.context,
    ).toBe("The repository describes a stolen bicycle.");
    await page.reload({ waitUntil: "networkidle0" });
    expect(await page.$eval("main textarea", (field) => field.value)).toBe(
      "The repository describes a stolen bicycle.",
    );
    expect(problems).toStrictEqual([]);
  },
);

browserTest(
  "hundreds of context scopes keep one editor, preserve drafts and fit a mobile viewport",
  { prepare },
  async ({ server, browser }) => {
    await server.service.upload(SYSTEM, {
      partial: true,
      files: Array.from({ length: 250 }, (_, index) => ({
        path: `catalog/entry-${index}.json`,
        repoPath: `src/locales/en/catalog/entry-${index}.json`,
        content: '{"label":"Catalog entry"}',
      })),
    });
    const { page, problems } = await openTab(browser, server, "/signin", (page) =>
      page.setViewport({ width: 1600, height: 1000 }),
    );
    await signIn(page);
    await page.goto(`${server.url}/settings?section=files`, { waitUntil: "networkidle0" });
    expect(await page.$$eval("main textarea", (fields) => fields.length)).toBe(1);
    await fill(page, "::-p-aria(Search folders and files)", "newspaper");
    await selectScope(page, "folder:newspaper");
    await fill(page, "::-p-aria(Context for this folder)", "An unsaved newspaper draft.");
    await fill(page, "::-p-aria(Search folders and files)", "");
    await selectScope(page, "folder:");
    expect(await page.$eval("main textarea", (field) => field.value)).toBe(
      "Write for the city's residents.",
    );
    await fill(page, "::-p-aria(Search folders and files)", "newspaper");
    await selectScope(page, "folder:newspaper");
    expect(await page.$eval("main textarea", (field) => field.value)).toBe(
      "An unsaved newspaper draft.",
    );
    expect(
      (await server.service.getSettings(SYSTEM, {})).folders.find(
        (folder) => folder.path === "newspaper",
      )?.context,
    ).toBe("Use a lively newspaper voice.");
    await page.locator("::-p-aria(Discard changes)").click();
    expect(await page.$eval("main textarea", (field) => field.value)).toBe(
      "Use a lively newspaper voice.",
    );
    await fill(page, "::-p-aria(Search folders and files)", "no-such-context-scope");
    await waitFor(page, () => document.querySelector("main")?.textContent?.includes("No matching"));
    expect(await page.$$eval("[data-scope]", (scopes) => scopes.length)).toBe(0);
    await fill(page, "::-p-aria(Search folders and files)", "");
    await waitFor(page, () => document.querySelectorAll("[data-scope]").length === 40);
    const list = await page.$eval(".context-list", (element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));
    assert(list.height < 800);
    expect(await page.$$eval("[data-scope]", (scopes) => scopes.length)).toBe(40);
    await page.locator('nav[aria-label="Context pages"] button::-p-text(Next)').click();
    await waitFor(page, () =>
      document.querySelector('nav[aria-label="Context pages"]')?.textContent?.includes("2 /"),
    );
    const file = (await server.service.getSettings(SYSTEM, {})).files.find(
      (file) => file.path === "newspaper/crime/theft.json",
    )!;
    await page.locator("::-p-aria(Search folders and files)").fill("newspaper");
    await selectScope(page, `file:${file.id}`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await page.screenshot({ path: join(tmpdir(), "quaso-context-desktop.png"), fullPage: true });
    await page.setViewport({ width: 360, height: 800 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    expect(await page.$$eval("main textarea", (fields) => fields.length)).toBe(1);
    await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await page.screenshot({ path: join(tmpdir(), "quaso-context-mobile.png"), fullPage: true });
    expect(await text(page, "h1")).toBe("Context");
    expect(problems).toStrictEqual([]);
  },
);
