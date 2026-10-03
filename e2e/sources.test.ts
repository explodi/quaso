// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
import { assert, assertEquals, assertStringIncludes } from "@quaso/runtime/assert";
import { browserTest, openTab, press, text, waitFor } from "./_setup.ts";

browserTest(
  "source trees use repository folders, counts and remembered-language identity links",
  {},
  async ({ server, browser }) => {
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [
          {
            path: "common.json",
            repoPath: "src/locales/en/common.json",
            content: '{"one":"Hello there","two":"Good morning"}',
          },
          {
            path: "menus/play.json",
            repoPath: "src/locales/en/menus/play.json",
            content: '{"play":"Play"}',
          },
        ],
        sourceLanguage: "en",
        languages: ["de", "fr"],
      }),
    });
    const { page, problems } = await openTab(browser, server, "/sources", (page) =>
      page.setViewport({ width: 1440, height: 1000 }),
    );
    await waitFor(page, () => document.querySelectorAll(".tree-counts time").length === 2);
    assertEquals(
      await page.$eval('a.tree-name[href*="common.json"]', (element) =>
        element.getAttribute("href"),
      ),
      "/translate/de?file=common.json",
    );
    assertStringIncludes(
      await text(page, '.tree-item[data-path="src/"] > .tree-row .tree-counts'),
      "3 strings",
    );
    assertStringIncludes(
      await text(page, '.tree-item[data-path="src/"] > .tree-row .tree-counts'),
      "5 words",
    );
    assertEquals(await page.$(".sources-page progress"), null);
    assert(await page.$('a[aria-current="page"][href="/sources"]'));
    await page.focus('.tree-item[data-path="menus/play.json"]');
    await press(page, "ArrowLeft");
    await waitFor(
      page,
      () => document.activeElement?.getAttribute("data-path") === "src/locales/en/menus/",
    );
    await press(page, "ArrowLeft");
    await waitFor(page, () => document.activeElement?.getAttribute("aria-expanded") === "false");
    await press(page, "ArrowRight");
    await press(page, "ArrowRight");
    await waitFor(
      page,
      () => document.activeElement?.getAttribute("data-path") === "menus/play.json",
    );
    await press(page, "Enter");
    await waitFor(
      page,
      () =>
        location.pathname === "/translate/de" &&
        new URLSearchParams(location.search).get("file") === "menus/play.json",
    );
    await waitFor(
      page,
      () => document.querySelector('.pane-files [data-path="src/locales/en/"]') !== null,
    );
    await page.goto(`${server.url}/languages/fr`, { waitUntil: "networkidle0" });
    assert(await page.$('.tree-item[data-path="src/locales/en/"]'));
    await page.goto(`${server.url}/sources`, { waitUntil: "networkidle0" });
    await waitFor(
      page,
      () => document.querySelector('a.tree-name[href="/translate/fr?file=common.json"]') !== null,
    );
    await page.reload({ waitUntil: "networkidle0" });
    assert(await page.$('a.tree-name[href="/translate/fr?file=common.json"]'));
    await page.type('.sources-page input[type="search"]', "menus");
    await waitFor(
      page,
      () =>
        document.querySelector('.sources-page [role="status"]')?.textContent === "1 file shown.",
    );
    assertEquals(await page.$('.tree-item[data-path="common.json"]'), null);
    await page.goto(`${server.url}/sources`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: "/private/tmp/quaso-sources-desktop.png", fullPage: true });
    await page.setViewport({ width: 360, height: 800 });
    await page.screenshot({ path: "/private/tmp/quaso-sources-mobile.png", fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const accessibility = await page.createCDPSession();
    const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
    assert(
      nodes.some((node) => node.role?.value === "tree" && node.name?.value === "Source files"),
    );
    assert(
      nodes.some(
        (node) => node.role?.value === "searchbox" && node.name?.value === "Filter source files",
      ),
    );
    assert(nodes.some((node) => node.role?.value === "heading" && node.name?.value === "Sources"));
    assertEquals(problems, []);
  },
);

browserTest(
  "source pages handle no languages and an empty project",
  {},
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/sources");
    await waitFor(page, () =>
      document.querySelector(".sources-page")?.textContent?.includes("No source files yet"),
    );
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "empty.json", repoPath: "src/en/empty.json", content: "{}" }],
      }),
    });
    await page.reload({ waitUntil: "networkidle0" });
    await waitFor(page, () =>
      document.querySelector(".tree-counts")?.textContent?.includes("0 strings"),
    );
    assertStringIncludes(await text(page, ".sources-page"), "Add a target language");
    assertEquals(await page.$("a.tree-name"), null);
    assertEquals(problems, []);
  },
);
