// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ANONYMOUS, SYSTEM } from "@quaso/service";
import { browserTest, MANAGER_SESSION, openTab, press, text, waitFor } from "./_setup.ts";

browserTest(
  "the overview opens a language directly and remembers where to continue",
  { seed: true },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/", (page) =>
      page.setViewport({ width: 1440, height: 900 }),
    );
    await waitFor(
      page,
      () => document.querySelector('.language-open[href="/translate/fr"]') !== null,
    );
    await page.click('.language-open[href="/translate/fr"]');
    await waitFor(page, () => location.pathname === "/translate/fr");
    await waitFor(page, () => document.querySelector(".panel-key code") !== null);
    assertStringIncludes(await text(page, "main h1"), "French");
    assertEquals(await page.evaluate(() => document.activeElement?.tagName), "H1");
    assert(await page.$('.nav a[aria-current="page"][href="/"]'));

    await page.click(".header .brand");
    await waitFor(page, () => location.pathname === "/");
    await waitFor(page, () =>
      [...document.querySelectorAll<HTMLAnchorElement>("main a")].some(
        (link) =>
          link.getAttribute("href")?.startsWith("/translate/fr") &&
          link.textContent?.includes("Continue"),
      ),
    );
    await page.reload({ waitUntil: "networkidle0" });
    await waitFor(page, () =>
      [...document.querySelectorAll<HTMLAnchorElement>("main a")].some(
        (link) =>
          link.getAttribute("href")?.startsWith("/translate/fr") &&
          link.textContent?.includes("Continue"),
      ),
    );
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>("main a")]
        .find(
          (link) =>
            link.getAttribute("href")?.startsWith("/translate/fr") &&
            link.textContent?.includes("Continue"),
        )!
        .click(),
    );
    await waitFor(page, () => location.pathname === "/translate/fr");
    await waitFor(page, () => document.querySelector(".panel-key code") !== null);
    assertEquals(problems, []);
  },
);

browserTest(
  "the overview resumes a contributor's language rather than a remembered read-only language",
  {
    seed: true,
    session: {
      ...MANAGER_SESSION,
      user: { ...MANAGER_SESSION.user!, role: "contributor", languages: ["fr"] },
    },
  },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/", async (page) => {
      await page.evaluateOnNewDocument(() => localStorage.setItem("quaso:last-language", "ar"));
    });
    await waitFor(
      page,
      () => document.querySelector('.workspace-resume[href="/translate/fr"]') !== null,
    );
    assertStringIncludes(await text(page, ".workspace-resume"), "Continue in French");
    await page.click(".workspace-resume");
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    assertStringIncludes(await text(page, "#edit-heading"), "Your suggestion (French)");
    assertEquals(problems, []);
  },
);

browserTest(
  "language search and sorting survive a reload and preserve file browsing",
  { seed: true },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/?q=French&sort=least");
    await waitFor(page, () => document.querySelectorAll(".language-row").length === 1);
    assertEquals(
      await page.$eval("#language-search", (input) => (input as HTMLInputElement).value),
      "French",
    );
    assertEquals(
      await page.$eval(".languages-card select", (select) => (select as HTMLSelectElement).value),
      "least",
    );
    assertStringIncludes(await text(page, ".language-row"), "French");
    assert(await page.$('.language-open[href="/translate/fr"]'));
    assert(await page.$('.language-link[href="/languages/fr"]'));

    await page.focus("#language-search");
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>("#language-search")!.select(),
    );
    await page.keyboard.type("German");
    await waitFor(page, () => new URLSearchParams(location.search).get("q") === "German");
    await page.reload({ waitUntil: "networkidle0" });
    await waitFor(page, () => document.querySelectorAll(".language-row").length === 1);
    assertStringIncludes(await text(page, ".language-row"), "German");
    assertEquals(
      await page.evaluate(() => new URLSearchParams(location.search).get("sort")),
      "least",
    );
    await page.click('.language-link[href="/languages/de"]');
    await waitFor(page, () => location.pathname === "/languages/de");
    await waitFor(page, () => document.querySelector('[role="treeitem"]') !== null);
    assertStringIncludes(await text(page, "main h1"), "German");
    assertEquals(problems, []);
  },
);

browserTest(
  "the narrow editor moves between the string list and focused translation",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/translate/de", (page) =>
      page.setViewport({ width: 360, height: 800 }),
    );
    await waitFor(page, () => document.querySelector(".panel-key code") !== null);
    assert(await page.$eval(".pane-strings", (pane) => pane.getClientRects().length > 0));
    assert(await page.$eval(".pane-panel", (pane) => pane.getClientRects().length === 0));
    await page.click(".string-list .row-link");
    await waitFor(page, () => document.querySelector(".pane-panel")!.getClientRects().length > 0);
    await waitFor(page, () =>
      document.querySelector(".pane-panel")!.contains(document.activeElement),
    );
    assert(await page.evaluate(() => document.activeElement!.getBoundingClientRect().width > 0));
    assert(
      await page.$eval(
        'button[aria-controls="editor-translation"]',
        (button) => button.getAttribute("aria-pressed") === "true",
      ),
    );
    await page.reload({ waitUntil: "networkidle0" });
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    assert(await page.$eval(".pane-panel", (pane) => pane.getClientRects().length > 0));

    await page.click('button[aria-controls="editor-strings"]');
    await waitFor(page, () => document.querySelector(".pane-strings")!.getClientRects().length > 0);
    assert(await page.$eval(".pane-panel", (pane) => pane.getClientRects().length === 0));
    assert(
      await page.evaluate(
        () =>
          document.activeElement !== document.body &&
          document.activeElement!.getBoundingClientRect().width > 0,
      ),
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assertEquals(problems, []);
  },
);

browserTest(
  "resizing the editor keeps the focused translation visible",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/translate/de", (page) =>
      page.setViewport({ width: 800, height: 900 }),
    );
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    await page.focus(".pane-panel textarea");
    await page.setViewport({ width: 360, height: 800 });
    assert(await page.$eval(".pane-panel", (pane) => pane.getClientRects().length > 0));
    assertEquals(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
    assert(await page.evaluate(() => document.activeElement!.getBoundingClientRect().width > 0));
    assert(
      await page.$eval(
        'button[aria-controls="editor-translation"]',
        (button) => button.getAttribute("aria-pressed") === "true",
      ),
    );
    assertEquals(problems, []);
  },
);

browserTest(
  "source files open in the chosen language and keep their filter",
  { seed: true },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/sources?language=fr&filter=common");
    await waitFor(
      page,
      () => document.querySelector('.tree-name[href="/translate/fr?file=common.json"]') !== null,
    );
    assertEquals(
      await page.$eval(
        ".source-language-choice select",
        (select) => (select as HTMLSelectElement).value,
      ),
      "fr",
    );
    await page.select(".source-language-choice select", "de");
    await waitFor(page, () => new URLSearchParams(location.search).get("language") === "de");
    assertEquals(
      await page.evaluate(() => new URLSearchParams(location.search).get("filter")),
      "common",
    );
    await page.reload({ waitUntil: "networkidle0" });
    await waitFor(
      page,
      () => document.querySelector('.tree-name[href="/translate/de?file=common.json"]') !== null,
    );
    assertEquals(
      await page.$eval(
        '.sources-page input[type="search"]',
        (input) => (input as HTMLInputElement).value,
      ),
      "common",
    );
    await page.click('.tree-name[href="/translate/de?file=common.json"]');
    await waitFor(page, () => location.pathname === "/translate/de");
    assertEquals(
      await page.evaluate(() => new URLSearchParams(location.search).get("file")),
      "common.json",
    );
    await waitFor(page, () => document.querySelector(".panel-key code") !== null);
    assertEquals(problems, []);
  },
);

browserTest(
  "settings sections support browser history on desktop and narrow screens",
  {
    async prepare(service) {
      const { token } = await service.ensureSetupToken(SYSTEM, {});
      await service.completeSetup(ANONYMOUS, {
        token: token!,
        email: "workspace-owner@example.com",
        password: "a long workspace password",
        displayName: "Workspace Owner",
        projectName: "Workspace history",
      });
    },
  },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/signin", (page) =>
      page.setViewport({ width: 1440, height: 900 }),
    );
    await page.type('input[type="email"]', "workspace-owner@example.com");
    await page.type('input[type="password"]', "a long workspace password");
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector(".user-name") !== null);
    await page.goto(`${server.url}/settings?section=general`, { waitUntil: "networkidle0" });
    await page.click('.settings-navigation a[href="/settings?section=retention"]');
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "retention");
    assertStringIncludes(await text(page, ".settings-section-intro"), "History & retention");
    await page.goBack({ waitUntil: "networkidle0" });
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "general");
    assertStringIncludes(await text(page, ".settings-section-intro"), "Project details");
    assert(
      await page.$('.settings-navigation a[aria-current="page"][href="/settings?section=general"]'),
    );

    await page.setViewport({ width: 360, height: 800 });
    await page.select(".settings-mobile-section select", "retention");
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "retention");
    await page.goBack({ waitUntil: "networkidle0" });
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "general");
    assertEquals(
      await page.$eval(
        ".settings-mobile-section select",
        (select) => (select as HTMLSelectElement).value,
      ),
      "general",
    );
    await page.goForward({ waitUntil: "networkidle0" });
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "retention");
    await page.reload({ waitUntil: "networkidle0" });
    assertStringIncludes(await text(page, ".settings-section-intro"), "History & retention");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assertEquals(problems, []);
  },
);

browserTest(
  "workspace navigation supports keyboard entry on desktop and narrow screens",
  {
    seed: true,
    session: {
      ...MANAGER_SESSION,
      user: { ...MANAGER_SESSION.user!, role: "administrator" },
    },
  },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/sources", (page) =>
      page.setViewport({ width: 1440, height: 900 }),
    );
    await waitFor(page, () =>
      [...document.querySelectorAll<HTMLAnchorElement>('.nav a[href="/activity"]')].some(
        (link) => link.getBoundingClientRect().width > 0,
      ),
    );
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>('.nav a[href="/activity"]')]
        .find((link) => link.getBoundingClientRect().width > 0)!
        .focus(),
    );
    await press(page, "Enter");
    await waitFor(page, () => location.pathname === "/activity");
    await waitFor(page, () => document.activeElement?.tagName === "H1");
    assertStringIncludes(await text(page, "main h1"), "Activity");
    assert(await page.$('.nav a[aria-current="page"][href="/activity"]'));
    assert(
      await page.$eval(
        '.nav a[href="/settings"]',
        (link) => link.getBoundingClientRect().width > 0,
      ),
    );

    await page.setViewport({ width: 360, height: 800 });
    await page.focus(".nav-overflow button");
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector('.nav .menu a[href="/glossary"]') !== null);
    assert(await page.$('.nav .menu a[href="/review"]'));
    assert(await page.$('.nav .menu a[href="/settings"]'));
    assert(
      await page.$eval(".nav .menu", (menu) => {
        const box = menu.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      }),
    );
    await page.focus('.nav .menu a[href="/glossary"]');
    await press(page, "Enter");
    await waitFor(page, () => location.pathname === "/glossary");
    await waitFor(page, () => document.activeElement?.tagName === "H1");
    assertEquals(await page.$(".nav .menu"), null);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assertEquals(problems, []);
  },
);
