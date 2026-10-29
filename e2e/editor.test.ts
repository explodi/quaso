// SPDX-License-Identifier: MIT
/**
 * The editor in a browser (S7.5–S7.7, S7.9): keyboard navigation in the string list and the
 * file tree, the shortcuts, plural inputs with example numbers, right-to-left inputs, live
 * checks, and a failed save that keeps the text.
 */
import { assert, expect } from "vitest";

import type { Page } from "puppeteer";
import { SYSTEM } from "@quaso/service";
import {
  browserTest,
  emulateMac,
  getStrings,
  MANAGER_SESSION,
  openTab,
  pagePath,
  press,
  sendKey,
  text,
  waitFor,
} from "./_setup.ts";

function selectedId(page: Page): Promise<string | null> {
  return page.evaluate(() => new URLSearchParams(location.search).get("id"));
}

function waitForPanel(page: Page, key: string) {
  return waitFor(
    page,
    (k: string) => document.querySelector(".panel-key code")?.textContent === k,
    [key],
  );
}

browserTest(
  "keyboard: the string list, Alt+↓ and Alt+↑, and the shortcuts dialog",
  { seed: true },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "de");
    const tab = await openTab(browser, server, "/translate/de?order=file");
    const { page } = tab;
    // The first string is selected when none is.
    await waitFor(page, () => new URLSearchParams(location.search).get("id") !== null);
    expect(await selectedId(page)).toStrictEqual(String(strings[0].id));
    await waitForPanel(page, strings[0].key);

    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[data-index="0"] .row-link')!.focus(),
    );
    await press(page, "ArrowDown");
    await press(page, "ArrowDown");
    await waitFor(
      page,
      () => document.activeElement?.closest<HTMLElement>("[data-index]")?.dataset.index === "2",
    );
    await press(page, "End");
    await waitFor(
      page,
      (n: number) =>
        Number(document.activeElement?.closest<HTMLElement>("[data-index]")?.dataset.index) === n,
      [strings.length - 1],
    );
    await press(page, "Home");
    await waitFor(
      page,
      () => document.activeElement?.closest<HTMLElement>("[data-index]")?.dataset.index === "0",
    );
    await press(page, "ArrowDown");
    await press(page, "Enter");
    await waitForPanel(page, strings[1].key);
    expect(await selectedId(page)).toStrictEqual(String(strings[1].id));

    // Alt+↓ and Alt+↑ move between strings; focus follows in the list.
    await press(page, "ArrowDown", ["Alt"]);
    await waitForPanel(page, strings[2].key);
    expect(await selectedId(page)).toStrictEqual(String(strings[2].id));
    await waitFor(
      page,
      () => document.activeElement?.closest<HTMLElement>("[data-index]")?.dataset.index === "2",
    );
    await press(page, "ArrowUp", ["Alt"]);
    await waitForPanel(page, strings[1].key);

    // "?" shows the shortcuts; Escape closes the dialog and focus comes back.
    await press(page, "?", ["Shift"]);
    await waitFor(page, () =>
      document.querySelector("dialog[open]")?.textContent?.includes("Keyboard shortcuts"),
    );
    assert(
      await page.evaluate(() =>
        document.querySelector("dialog[open]")!.contains(document.activeElement),
      ),
    );
    await press(page, "Escape");
    await waitFor(page, () => document.querySelector("dialog[open]") === null);
    await waitFor(page, () => document.activeElement?.classList.contains("row-link"));

    // The address is shareable: the filters and the string are in it.
    await page.evaluate(() => {
      [...document.querySelectorAll<HTMLInputElement>(".state-filter input")][3].click();
    });
    await waitFor(page, () => location.search.includes("state=blue"));
    expect(await pagePath(page)).toContain(`id=${strings[1].id}`);
    expect(tab.problems).toStrictEqual([]);
  },
);

browserTest(
  "keyboard: the file tree opens a file in the editor",
  { seed: true },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/languages/pl");
    const { page } = tab;
    await waitFor(
      page,
      () => document.querySelectorAll('[role="treeitem"][aria-selected]').length === 3,
    );
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[role="treeitem"][data-path="common.json"]')!.focus(),
    );
    await press(page, "ArrowDown");
    await waitFor(page, () => document.activeElement?.getAttribute("data-path") === "menus.json");
    await press(page, "Enter");
    await waitFor(
      page,
      () => location.pathname === "/translate/pl" && location.search.includes("file=menus.json"),
    );
    // Focus moves to the new page's heading, and the editor's tree shows the file selected.
    await waitFor(page, () => document.activeElement?.tagName === "H1");
    await waitFor(
      page,
      () =>
        document.querySelector('.pane-files [aria-selected="true"]')?.getAttribute("data-path") ===
        "menus.json",
    );
    expect(await text(page, "#strings-title")).toContain("menus.json");
    expect(tab.problems).toStrictEqual([]);
  },
);

browserTest(
  "a plural string in Polish has four inputs, with example numbers and live checks",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const coins = (await getStrings(server, "pl", "&q=coins")).strings.find(
      (s) => s.key === "coins",
    )!;
    const tab = await openTab(browser, server, `/translate/pl?id=${coins.id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelectorAll(".pane-panel textarea").length === 4);
    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLTextAreaElement>(".pane-panel textarea")].map((input) => ({
        label: document
          .querySelector(`label[for="${input.id}"]`)
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
        lang: input.lang,
        dir: input.dir,
        value: input.value,
      })),
    );
    expect(inputs.map((i) => i.label)).toStrictEqual([
      "Plural form one, for 1",
      "Plural form few, for 2–4, 22–24, 32–34, …",
      "Plural form many, for 0, 5–21, 25–31, …",
      "Plural form other, for 1.5",
    ]);
    for (const input of inputs) expect([input.lang, input.dir]).toStrictEqual(["pl", "ltr"]);
    expect(inputs[0].value).toBe("{{count}} moneta");

    // Emptying a form is an error, live, and blocks saving.
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>("#translation-few")!.select(),
    );
    await press(page, "Backspace");
    await waitFor(page, () =>
      document.querySelector("#translation-few-checks")?.textContent?.includes("empty"),
    );
    assert(
      await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>(".panel-actions button")].find(
            (b) => b.textContent === "Save",
          )!.disabled,
      ),
    );
    // Alt+1 inserts the first placeholder at the cursor, and the error goes away.
    await press(page, "1", ["Alt"]);
    await page.keyboard.type(" monety");
    await waitFor(
      page,
      () =>
        document.querySelector<HTMLTextAreaElement>("#translation-few")!.value ===
        "{{count}} monety",
    );
    await waitFor(
      page,
      () => !document.querySelector("#translation-few-checks")?.textContent?.includes("empty"),
    );
    expect(tab.problems).toStrictEqual([]);
  },
);

browserTest(
  "right-to-left: Arabic inputs get dir=rtl, and references are masked",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "ar");
    const again = strings.find((s) => s.key === "main.playAgain")!;
    const coins = strings.find((s) => s.key === "coins")!;
    const tab = await openTab(browser, server, `/translate/ar?id=${again.id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    expect(
      await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!;
        return [input.dir, input.lang, getComputedStyle(input).direction];
      }),
    ).toStrictEqual(["rtl", "ar", "rtl"]);
    // The reference is a chip, ⟦1⟧, with the English it refers to.
    expect(await text(page, ".chips")).toContain("⟦1⟧");
    expect(
      await page.evaluate(
        () => document.querySelector(".chip-reference")?.getAttribute("title") ?? "",
      ),
    ).toContain("$t(common:play): “Play”");
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.focus(),
    );
    await press(page, "1", ["Control"]);
    await page.keyboard.type(" مرة أخرى");
    await waitFor(
      page,
      () =>
        document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.value ===
        "⟦1⟧ مرة أخرى",
    );
    // The English goes in with Ctrl+Shift+C, replacing the text.
    await press(page, "C", ["Control", "Shift"]);
    await waitFor(
      page,
      () =>
        document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.value === "⟦1⟧ again",
    );

    // A plural string in Arabic: six forms, all right to left.
    await page.goto(`${server.url}/translate/ar?id=${coins.id}`, { waitUntil: "networkidle0" });
    await waitFor(page, () => document.querySelectorAll(".pane-panel textarea").length === 6);
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLTextAreaElement>(".pane-panel textarea")]
          .map((t) => t.dir)
          .join(","),
      ),
    ).toBe("rtl,rtl,rtl,rtl,rtl,rtl");
    expect(tab.problems).toStrictEqual([]);
  },
);

browserTest(
  "Ctrl+Enter opens the next string while the save runs; a refused save keeps its text",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "fr", "&state=untranslated");
    const target = strings[0];
    const tab = await openTab(browser, server, `/translate/fr?id=${target.id}&state=untranslated`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.focus(),
    );
    await page.keyboard.type("Bonjour");
    await press(page, "Enter", ["Control"]);
    await waitFor(page, (id) => new URLSearchParams(location.search).get("id") !== id, [
      String(target.id),
    ]);
    // The stand-in manager session exists only in the browser: the server has no session
    // cookie, so it refuses the save, and the string's row says so.
    const notSaved = await waitFor(
      page,
      () => document.querySelector(".row-link:has(.row-not-saved) .row-key code")?.textContent,
    );
    expect(notSaved).toStrictEqual(target.key);

    // Opening it again shows why, with the text as it was typed.
    await page.evaluate(() =>
      document.querySelector<HTMLElement>(".row-link:has(.row-not-saved)")!.click(),
    );
    await waitFor(page, () =>
      document
        .querySelector('.pane-panel [role="alert"]')
        ?.textContent?.includes("You need to sign in to do that."),
    );
    expect(await selectedId(page)).toStrictEqual(String(target.id));
    expect(
      await page.evaluate(
        () => document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.value,
      ),
    ).toBe("Bonjour");
    // The only problem is the expected refusal of the save itself.
    expect(
      tab.problems.filter((p) => !/status of 40[13] .*\/translations\/fr\)$/.test(p)),
    ).toStrictEqual([]);
    expect(tab.problems.length).toBe(1);
  },
);

/** Option+digit on a German Mac: the character the layout types on each key. */
const GERMAN_MAC = {
  "¡": { code: "Digit1", keyCode: 49 },
  "{": { code: "Digit8", keyCode: 56 },
  "}": { code: "Digit9", keyCode: 57 },
  "[": { code: "Digit5", keyCode: 53 },
  "]": { code: "Digit6", keyCode: 54 },
  "|": { code: "Digit7", keyCode: 55 },
  "“": { code: "Digit2", keyCode: 50 },
} as const;

async function typeWithOption(page: Page, characters: string) {
  for (const character of characters) {
    const key = GERMAN_MAC[character as keyof typeof GERMAN_MAC];
    await sendKey(page, { key: character, text: character, alt: true, ...key });
  }
}

browserTest(
  "on a Mac, Option+digit types { } [ ] | “ as the layout says; Control+digit inserts placeholders",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const score = (await getStrings(server, "de", "&q=gameOver.score")).strings.find(
      (s) => s.key === "gameOver.score",
    )!;
    const tab = await openTab(browser, server, "/", emulateMac);
    let page = tab.page;
    expect(await page.evaluate(() => navigator.platform)).toBe("MacIntel");
    // Control: a search box outside the editor gets the characters.
    await waitFor(page, () => document.querySelector("#language-search") !== null);
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>("#language-search")!.focus(),
    );
    await typeWithOption(page, "{}");
    expect(
      await page.evaluate(
        () => document.querySelector<HTMLInputElement>("#language-search")!.value,
      ),
    ).toBe("{}");

    // A new tab rather than a navigation: on Linux, Chrome drops the emulated platform when
    // the tab navigates, and the editor would take Option+digit for a placeholder shortcut.
    const editor = await openTab(browser, server, `/translate/de?id=${score.id}`, emulateMac);
    page = editor.page;
    await waitFor(page, () => document.querySelector("#translation-text") !== null);
    const value = () =>
      page.evaluate(() => document.querySelector<HTMLTextAreaElement>("#translation-text")!.value);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>("#translation-text")!;
      input.focus();
      input.select();
    });
    await page.keyboard.type("Punkte: ");
    await typeWithOption(page, "{{");
    await page.keyboard.type("score");
    // ⌥1 is ¡, not the first placeholder.
    await typeWithOption(page, "}} [|]“¡");
    expect(await value()).toBe("Punkte: {{score}} [|]“¡");
    // Control+1 inserts the first placeholder (⌘+1 is the browser's).
    await sendKey(page, { key: "1", code: "Digit1", ctrl: true, keyCode: 49 });
    await waitFor(
      page,
      () =>
        document.querySelector<HTMLTextAreaElement>("#translation-text")!.value ===
        "Punkte: {{score}} [|]“¡{{score}}",
    );
    // The editor's search box keeps its keys too, and focus stays there.
    await page.evaluate(() => document.querySelector<HTMLInputElement>("#string-search")!.focus());
    await typeWithOption(page, "[");
    await sendKey(page, { key: "1", code: "Digit1", ctrl: true, keyCode: 49 });
    expect(
      await page.evaluate(() => [
        document.querySelector<HTMLInputElement>("#string-search")!.value,
        document.activeElement?.id,
      ]),
    ).toStrictEqual(["[", "string-search"]);
    expect(await value()).toBe("Punkte: {{score}} [|]“¡{{score}}");
    // The shortcuts dialog names the Mac's keys.
    await page.evaluate(() => document.querySelector<HTMLElement>(".row-link")?.focus());
    await press(page, "?", ["Shift"]);
    await waitFor(page, () => document.querySelector("dialog[open]") !== null);
    expect(await text(page, "dialog[open]")).toContain("Control+1…9");
    expect(tab.problems).toStrictEqual([]);
    expect(editor.problems).toStrictEqual([]);
  },
);

browserTest(
  "a document: side by side by paragraph, the whole file and a preview",
  {
    session: MANAGER_SESSION,
    async prepare(service) {
      await service.upload(SYSTEM, {
        files: [
          {
            path: "news/festival.md",
            repoPath: "text/en/news/festival.md",
            content: "# The festival\n\nThe valley wakes up early.\n\n- Bring wheat.\n",
          },
        ],
        languages: ["de"],
      });
    },
  },
  async ({ server, browser }) => {
    const { page } = await openTab(browser, server, "/translate/de");
    await waitForPanel(page, "festival.md");
    const tab = (label: string) =>
      page.evaluate((label: string) => {
        const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
        tabs.find((element) => element.textContent === label)!.click();
      }, label);

    await tab("Side by side");
    await waitFor(
      page,
      () => document.querySelectorAll(".document-paragraph textarea").length === 3,
    );
    const paragraphs = await page.$$(".document-paragraph textarea");
    await paragraphs[0].type("# Das Fest");
    await paragraphs[1].type("Das Tal erwacht früh.");
    await paragraphs[2].type("- Bring Weizen mit.");
    expect(await text(page, ".panel-edit")).toContain("3 / 3 paragraphs");

    await tab("Whole file");
    await waitFor(page, () => document.querySelector("#translation-text") !== null);
    expect(
      await page.$eval("#translation-text", (element) => (element as HTMLTextAreaElement).value),
    ).toBe("# Das Fest\n\nDas Tal erwacht früh.\n\n- Bring Weizen mit.");

    await tab("Preview");
    await waitFor(page, () => document.querySelector(".markdown-preview") !== null);
    expect(await text(page, ".markdown-preview .markdown-heading-1")).toBe("Das Fest");
    expect(await text(page, ".markdown-preview li")).toBe("Bring Weizen mit.");
  },
);
