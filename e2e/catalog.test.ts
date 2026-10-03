// SPDX-License-Identifier: MIT
import { assert, assertEquals } from "@quaso/runtime/assert";
import { browserTest, openTab, press, waitFor } from "./_setup.ts";

browserTest("catalog controls have comfortable touch targets", {}, async ({ server, browser }) => {
  const { page, problems } = await openTab(browser, server, "/design.html");
  const undersized = await page.evaluate(() => {
    const controls = document.querySelectorAll<HTMLElement>(
      "button, .btn, .input, .select, .textarea, summary, label:has(> .choice-input, > .switch), .tree-row",
    );
    return [...controls]
      .filter((control) => {
        const box = control.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.height < 44;
      })
      .map((control) => ({
        control: control.outerHTML.slice(0, 180),
        height: control.offsetHeight,
      }));
  });
  assertEquals(undersized, []);
  assertEquals(
    await page.$eval(".field .select", (node) => node.getBoundingClientRect().height),
    await page.$eval(".field .input", (node) => node.getBoundingClientRect().height),
  );
  assertEquals(problems, []);
});

browserTest(
  "the catalog works without API calls and remembers its theme",
  {},
  async ({ server, browser }) => {
    const apiRequests: string[] = [];
    const { page, problems } = await openTab(browser, server, "/design.html", async (page) => {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      page.on("request", (request) => {
        if (/\/(api\/|config.json)/.test(request.url())) apiRequests.push(request.url());
      });
    });
    assertEquals(await page.title(), "Design system · Quaso");
    assert(await page.evaluate(() => document.fonts.check('400 32px "Jersey 25"')));
    await page.click('[role="switch"][aria-label="Dark mode"]');
    assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    assertEquals(
      await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      "rgb(38, 18, 48)",
    );
    await page.reload({ waitUntil: "networkidle0" });
    assert(
      await page.$eval('[aria-label="Dark mode"]', (node) => (node as HTMLInputElement).checked),
    );
    await page.click('[role="switch"][aria-label="Dark mode"]');
    assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    assertEquals(apiRequests, []);
    assertEquals(problems, []);
  },
);

browserTest(
  "catalog controls support keyboard use, dialogs, and the translation workflow",
  {},
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/design.html");
    await page.focus('input[name="review"][value="human"]');
    await press(page, "ArrowDown");
    assert(
      await page.$eval(
        'input[name="review"][value="all"]',
        (node) => (node as HTMLInputElement).checked,
      ),
    );
    await page.focus('[role="tab"]');
    await press(page, "ArrowRight");
    assertEquals(
      await page.$eval('[role="tab"][aria-selected="true"]', (node) => node.textContent),
      "Context",
    );
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Open example dialog")!
        .focus(),
    );
    await press(page, "Enter");
    await waitFor(page, () => Boolean(document.querySelector("dialog[open]")));
    await press(page, "Escape");
    assertEquals(
      await page.evaluate(() => document.activeElement?.textContent),
      "Open example dialog",
    );
    await page.type('textarea[aria-label="German translation"]', " Willkommen.");
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Save & proofread")!
        .focus(),
    );
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector(".catalog-workspace .badge-blue") !== null);
    assertEquals(
      await page.$eval(".catalog-workspace .textarea", (node) => getComputedStyle(node).transform),
      "none",
    );
    assertEquals(
      await page.$eval(".tree-selected > .tree-row", (node) => getComputedStyle(node).boxShadow),
      "none",
    );
    assertEquals(problems, []);
  },
);

browserTest(
  "the catalog fits narrow screens and enlarged text in both themes",
  {},
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/design.html", (page) =>
      page.setViewport({ width: 360, height: 800 }),
    );
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "360px layout should not scroll horizontally",
    );
    await page.click('[aria-label="Dark mode"]');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewport({ width: 768, height: 900 });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "768px layout should not scroll horizontally",
    );
    await page.setViewport({ width: 1440, height: 1000 });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "Enlarged text should not scroll horizontally",
    );
    assertEquals(problems, []);
  },
);
