// SPDX-License-Identifier: MIT
import { test } from "node:test";
/// <reference lib="dom" />
/**
 * The public website in a browser (S7.10): acceptance tests 2 and 11, and every page free
 * of console errors and Content Security Policy violations under the server's real headers.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Page } from "puppeteer";
import {
  browserTest,
  getProject,
  getStrings,
  MANAGER_SESSION,
  openTab,
  pagePath,
  startServer,
  text,
  uploadDemo,
  waitFor,
} from "./_setup.ts";
import { openBrowser } from "./_setup.ts";

interface Row {
  index: number;
  key: string;
  red: boolean;
  translated: boolean;
}

/** Scrolls the editor's virtual list from top to bottom and returns every row it rendered. */
async function allRows(page: Page): Promise<Row[]> {
  return await page.evaluate(async () => {
    const list = document.querySelector<HTMLElement>(".string-list")!;
    const seen = new Map<number, Row>();
    const pause = () => new Promise((done) => setTimeout(done, 60));
    const collect = () => {
      for (const row of list.querySelectorAll<HTMLElement>("[data-index]")) {
        const index = Number(row.dataset.index);
        seen.set(index, {
          index,
          key: row.querySelector(".row-key code")?.textContent ?? "",
          red: row.querySelector(".state-marker .state-red") !== null,
          translated:
            row.querySelector(".state-marker .state-green, .state-marker .state-blue") !== null,
        });
      }
    };
    list.scrollTop = 0;
    await pause();
    collect();
    while (list.scrollTop + list.clientHeight < list.scrollHeight - 1) {
      list.scrollTop += Math.max(60, list.clientHeight / 2);
      await pause();
      collect();
    }
    return [...seen.values()].sort((a, b) => a.index - b.index);
  });
}

/** Waits for the editor's list of a language to show its strings. */
function waitForList(page: Page, total: number) {
  return waitFor(
    page,
    (n: number) =>
      document.querySelector(".strings-status")?.textContent?.includes(`${n} strings`) &&
      document.querySelectorAll(".string-list [data-index]").length > 0,
    [total],
  );
}

browserTest(
  "acceptance test 2: after an upload, the dashboard shows every language and the editor every string, red",
  {},
  async ({ server, browser }) => {
    const upload = await uploadDemo(server);
    assert(upload.added.length > 0);
    const project = await getProject(server);
    assertEquals(project.languages.length, 6);

    const tab = await openTab(browser, server, "/");
    const { page } = tab;
    const names = await waitFor(page, () => {
      const rows = [...document.querySelectorAll(".language-row .language-name")];
      return rows.length > 0 ? rows.map((row) => row.firstChild?.textContent ?? "") : null;
    });
    assertEquals(names!.sort(), project.languages.map((l) => l.name).sort());
    const stats = await page.evaluate(() =>
      [...document.querySelectorAll(".language-stats")].map((e) => e.textContent ?? ""),
    );
    for (const line of stats) assertStringIncludes(line, "0% translated • 0% proofread");

    // The first language through the website's links, the others by address.
    const first = project.languages[0];
    await page.evaluate((tag: string) => {
      document.querySelector<HTMLAnchorElement>(`a[href="/languages/${tag}"]`)!.click();
    }, first.tag);
    await waitFor(
      page,
      (name: string) => document.querySelector("main h1")?.textContent?.startsWith(name),
      [first.name],
    );
    await page.evaluate(() => {
      [...document.querySelectorAll<HTMLAnchorElement>("a")]
        .find((a) => a.textContent === "Translate all")!
        .click();
    });

    for (const language of project.languages) {
      const strings = await getStrings(server, language.tag);
      if (language !== first) {
        await page.goto(`${server.url}/translate/${language.tag}`, { waitUntil: "networkidle0" });
      }
      assertEquals(
        await pagePath(page).then((path) => path.split("?")[0]),
        `/translate/${language.tag}`,
      );
      await waitForList(page, strings.total);
      const rows = await allRows(page);
      assertEquals(
        rows.map((row) => row.key),
        strings.strings.map((s) => s.key),
        language.tag,
      );
      for (const row of rows) {
        assert(row.red && !row.translated, `${language.tag}: ${row.key} isn't red`);
      }
      // The filters agree: every string is untranslated.
      assertStringIncludes(await text(page, ".state-filter"), `Untranslated ${strings.total}`);
    }
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "acceptance test 11: without an account, anyone browses every language and string, and changes nothing",
  { seed: true },
  async ({ server, browser }) => {
    const project = await getProject(server);
    const tab = await openTab(browser, server, "/");
    const { page } = tab;
    await waitFor(page, () => document.querySelectorAll(".language-row").length > 0);
    assertStringIncludes(await text(page, ".header"), "Sign in");

    for (const language of project.languages) {
      const strings = await getStrings(server, language.tag);
      // The language page, through the dashboard's link.
      await page.goto(`${server.url}/`, { waitUntil: "networkidle0" });
      await page.evaluate((tag: string) => {
        document.querySelector<HTMLAnchorElement>(`a[href="/languages/${tag}"]`)!.click();
      }, language.tag);
      await waitFor(
        page,
        () => document.querySelectorAll('[role="treeitem"][aria-selected]').length === 3,
      );
      assertStringIncludes(await text(page, "main h1"), language.name);
      // Then the editor, and every string in it.
      await waitFor(page, () =>
        [...document.querySelectorAll("a")].some((a) => a.textContent === "Translate all"),
      );
      await page.evaluate(() => {
        [...document.querySelectorAll<HTMLAnchorElement>("a")]
          .find((a) => a.textContent === "Translate all")!
          .click();
      });
      await waitForList(page, strings.total);
      // The editor lists strings in queue order, so each row says which key it is.
      const browsed = await page.evaluate(async (count: number) => {
        const problems: string[] = [];
        const seen: string[] = [];
        const list = document.querySelector<HTMLElement>(".string-list")!;
        const pause = () => new Promise((done) => setTimeout(done, 20));
        for (let index = 0; index < count; index++) {
          list.scrollTop = index * 60;
          let link: HTMLAnchorElement | null = null;
          for (let i = 0; i < 100 && !link; i++) {
            link = list.querySelector<HTMLAnchorElement>(`[data-index="${index}"] .row-link`);
            if (!link) await pause();
          }
          if (!link) {
            problems.push(`row ${index} not rendered`);
            continue;
          }
          const key = link.querySelector(".row-key code")?.textContent ?? "";
          seen.push(key);
          link.click();
          let shown = false;
          for (let i = 0; i < 200 && !shown; i++) {
            shown =
              document.querySelector(".panel-key code")?.textContent === key &&
              document.querySelector(".signin-prompt") !== null;
            if (!shown) await pause();
          }
          if (!shown) problems.push(`${key}: not shown with the sign-in prompt`);
          const panel = document.querySelector(".pane-panel")!;
          if (panel.querySelector("textarea")) problems.push(`${key}: an input`);
          const actions = [...panel.querySelectorAll("button")]
            .map((b) => b.textContent?.trim() ?? "")
            .filter((label) =>
              /^(Save|Suggest|Approve|Unapprove|Delete|Looks good|Translate with the LLM)$/.test(
                label,
              ),
            );
          if (actions.length > 0) problems.push(`${key}: ${actions.join(", ")}`);
        }
        if (document.querySelector(".row-check")) problems.push("selection checkboxes");
        return { problems, seen };
      }, strings.total);
      assertEquals(browsed.problems, [], language.tag);
      assertEquals(browsed.seen.toSorted(), strings.strings.map((s) => s.key).toSorted());
      assertStringIncludes(await text(page, ".signin-prompt"), "Sign in to suggest a translation");
    }

    // The tabs are readable too.
    for (const tabName of ["History", "Suggestions", "Other languages"]) {
      await page.evaluate((name: string) => {
        [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
          .find((t) => t.textContent?.startsWith(name))!
          .click();
      }, tabName);
      await waitFor(
        page,
        (name: string) =>
          document
            .querySelector('[role="tab"][aria-selected="true"]')
            ?.textContent?.startsWith(name) &&
          (document.querySelector('[role="tabpanel"]')?.textContent ?? "").length > 0,
        [tabName],
      );
    }
    assertStringIncludes(await text(page, '[role="tabpanel"]'), "German");
    assertEquals(tab.problems, []);
  },
);

test(
  "every page works under the server's Content Security Policy, without console errors",
  {},
  async () => {
    for (const session of [undefined, MANAGER_SESSION]) {
      const server = await startServer({ seed: true, session });
      const browser = await openBrowser();
      try {
        const response = await fetch(`${server.url}/translate/de`);
        await response.body?.cancel();
        const csp = response.headers.get("content-security-policy") ?? "";
        assertStringIncludes(csp, "script-src 'self'");
        assert(!csp.includes("unsafe-eval"));
        const strings = await getStrings(server, "pl", "&q=coins");
        const paths = [
          "/",
          "/languages/de",
          "/translate/de",
          `/translate/pl?id=${strings.strings[0].id}`,
          "/translate/ar?state=untranslated",
          "/translate/de/menus.json",
          "/activity",
          "/signin",
          "/signup?invite=abc",
          "/forgot-password",
          "/reset-password?token=abc",
          "/no/such/page",
        ];
        for (const path of paths) {
          const tab = await openTab(browser, server, path);
          await waitFor(tab.page, () => document.querySelector("main h1") !== null);
          // Give polling and late renders a moment.
          await new Promise((done) => setTimeout(done, 300));
          assertEquals(tab.problems, [], `${path} (${session ? "manager" : "anonymous"})`);
          await tab.page.close();
        }
      } finally {
        await browser.close();
        await server.close();
      }
    }
  },
);

browserTest(
  "the theme follows the system unless a visitor picks one, and is remembered",
  { seed: true },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/");
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".theme-menu .dropdown-trigger") !== null);
    // The bg tokens of packages/web/src/styles/tokens.ts: ink 950 (dark) and paper 50 (light).
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    assertEquals(await background(), "rgb(38, 18, 48)");
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    assertEquals(await background(), "rgb(244, 244, 241)");
    await page.click(".theme-menu .dropdown-trigger");
    await page.click('.theme-menu input[type="radio"][value="dark"]');
    await waitFor(page, () => document.documentElement.dataset.theme === "dark");
    assertEquals(await background(), "rgb(38, 18, 48)");
    await page.reload({ waitUntil: "networkidle0" });
    await waitFor(page, () => document.documentElement.dataset.theme === "dark");
    assertEquals(await background(), "rgb(38, 18, 48)");
    assertEquals(tab.problems, []);
  },
);
