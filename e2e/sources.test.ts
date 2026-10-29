// SPDX-License-Identifier: MIT
import { assert, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(
      await page.$eval('a.tree-name[href*="common.json"]', (element) =>
        element.getAttribute("href"),
      ),
    ).toBe("/translate/de?file=common.json");
    expect(await text(page, '.tree-item[data-path="src/"] > .tree-row .tree-counts')).toContain(
      "3 strings",
    );
    expect(await text(page, '.tree-item[data-path="src/"] > .tree-row .tree-counts')).toContain(
      "5 words",
    );
    expect(await page.$(".sources-page progress")).toBe(null);
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
    expect(
      await page.$eval(
        ".source-language-choice select",
        (select) => (select as HTMLSelectElement).value,
      ),
    ).toBe("fr");
    await page.select(".source-language-choice select", "de");
    await waitFor(page, () => new URLSearchParams(location.search).get("language") === "de");
    assert(await page.$('a.tree-name[href="/translate/de?file=common.json"]'));
    await page.reload({ waitUntil: "networkidle0" });
    expect(
      await page.$eval(
        ".source-language-choice select",
        (select) => (select as HTMLSelectElement).value,
      ),
    ).toBe("de");
    assert(await page.$('a.tree-name[href="/translate/de?file=common.json"]'));
    await page.type('.sources-page input[type="search"]', "menus");
    await waitFor(
      page,
      () =>
        document.querySelector('.sources-page [role="status"]')?.textContent === "1 file shown.",
    );
    expect(await page.$('.tree-item[data-path="common.json"]')).toBe(null);
    await page.goto(`${server.url}/sources`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: join(tmpdir(), "quaso-sources-desktop.png"), fullPage: true });
    await page.setViewport({ width: 360, height: 800 });
    await page.screenshot({ path: join(tmpdir(), "quaso-sources-mobile.png"), fullPage: true });
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
    expect(problems).toStrictEqual([]);
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
    expect(await text(page, ".sources-page")).toContain("Add a target language");
    expect(await page.$("a.tree-name")).toBe(null);
    expect(problems).toStrictEqual([]);
  },
);
