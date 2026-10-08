// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
/**
 * The editor in a browser (S7.5–S7.7, S7.9): keyboard navigation in the string list and the
 * file tree, the shortcuts, plural inputs with example numbers, right-to-left inputs, live
 * checks, and a failed save that keeps the text.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Page } from "puppeteer";
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
    assertEquals(await selectedId(page), String(strings[0].id));
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
    assertEquals(await selectedId(page), String(strings[1].id));

    // Alt+↓ and Alt+↑ move between strings; focus follows in the list.
    await press(page, "ArrowDown", ["Alt"]);
    await waitForPanel(page, strings[2].key);
    assertEquals(await selectedId(page), String(strings[2].id));
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
    assertStringIncludes(await pagePath(page), `id=${strings[1].id}`);
    assertEquals(tab.problems, []);
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
    assertStringIncludes(await text(page, "#strings-title"), "menus.json");
    assertEquals(tab.problems, []);
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
    assertEquals(
      inputs.map((i) => i.label),
      [
        "Plural form one, for 1",
        "Plural form few, for 2–4, 22–24, 32–34, …",
        "Plural form many, for 0, 5–21, 25–31, …",
        "Plural form other, for 1.5",
      ],
    );
    for (const input of inputs) assertEquals([input.lang, input.dir], ["pl", "ltr"]);
    assertEquals(inputs[0].value, "{{count}} moneta");

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
    assertEquals(tab.problems, []);
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
    assertEquals(
      await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!;
        return [input.dir, input.lang, getComputedStyle(input).direction];
      }),
      ["rtl", "ar", "rtl"],
    );
    // The reference is a chip, ⟦1⟧, with the English it refers to.
    assertStringIncludes(await text(page, ".chips"), "⟦1⟧");
    assertStringIncludes(
      await page.evaluate(
        () => document.querySelector(".chip-reference")?.getAttribute("title") ?? "",
      ),
      "$t(common:play): “Play”",
    );
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
    assertEquals(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLTextAreaElement>(".pane-panel textarea")]
          .map((t) => t.dir)
          .join(","),
      ),
      "rtl,rtl,rtl,rtl,rtl,rtl",
    );
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "Ctrl+Enter saves; when the server refuses the save, the page says why and the text stays",
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
    // The stand-in manager session exists only in the browser: the server has no session
    // cookie, so it refuses the save, and the page says so.
    await waitFor(page, () =>
      document
        .querySelector('.pane-panel [role="alert"]')
        ?.textContent?.includes("You need to sign in to do that."),
    );
    assertEquals(await selectedId(page), String(target.id));
    assertEquals(
      await page.evaluate(
        () => document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.value,
      ),
      "Bonjour",
    );
    // The only problem is the expected refusal of the save itself.
    assertEquals(
      tab.problems.filter((p) => !/status of 40[13] .*\/translations\/fr\)$/.test(p)),
      [],
    );
    assertEquals(tab.problems.length, 1);
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
    const { page } = tab;
    assertEquals(await page.evaluate(() => navigator.platform), "MacIntel");
    // Control: a search box outside the editor gets the characters.
    await waitFor(page, () => document.querySelector("#language-search") !== null);
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>("#language-search")!.focus(),
    );
    await typeWithOption(page, "{}");
    assertEquals(
      await page.evaluate(
        () => document.querySelector<HTMLInputElement>("#language-search")!.value,
      ),
      "{}",
    );

    await page.goto(`${server.url}/translate/de?id=${score.id}`, { waitUntil: "networkidle0" });
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
    await page.evaluate(() => {
      (globalThis as any).__keys = [];
      document.addEventListener("keydown", (e) => (globalThis as any).__keys.push(`${e.key}|${e.code}|alt=${e.altKey}|ctrl=${e.ctrlKey}|meta=${e.metaKey}|${navigator.platform}`), true);
    });
    await typeWithOption(page, "}} [|]“¡");
    assertEquals(await value(), "Punkte: {{score}} [|]“¡", JSON.stringify(await page.evaluate(() => (globalThis as any).__keys)));
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
    assertEquals(
      await page.evaluate(() => [
        document.querySelector<HTMLInputElement>("#string-search")!.value,
        document.activeElement?.id,
      ]),
      ["[", "string-search"],
    );
    assertEquals(await value(), "Punkte: {{score}} [|]“¡{{score}}");
    // The shortcuts dialog names the Mac's keys.
    await page.evaluate(() => document.querySelector<HTMLElement>(".row-link")?.focus());
    await press(page, "?", ["Shift"]);
    await waitFor(page, () => document.querySelector("dialog[open]") !== null);
    assertStringIncludes(await text(page, "dialog[open]"), "Control+1…9");
    assertEquals(tab.problems, []);
  },
);
