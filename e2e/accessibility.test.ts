// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
/**
 * Keyboard focus and what assistive technology gets, in a browser (S7.9, WCAG 2.2 AA): focus
 * never drops to the page's body after an action, never hides under the sticky header or
 * the narrow screen's files overlay; toasts wait while someone reads them; live regions
 * exist before their first message; targets are large enough; the current page isn't told
 * by colour alone; and filtering says how many things match.
 */
import { assert, assertEquals, assertStringIncludes } from "@quaso/runtime/assert";
import type { Page } from "puppeteer";
import type { ActivityResult, FilesResult, ProjectInfo, StringDetail } from "@quaso/core";
import {
  apiError,
  browserTest,
  getStrings,
  MANAGER_SESSION,
  openTab,
  press,
  serverJson,
  text,
  waitFor,
} from "./_setup.ts";

/** What has focus: its id, or its tag and text. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "BODY";
    return element.id ? `#${element.id}` : `${element.tagName}:${element.textContent?.trim()}`;
  });
}

function sleep(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Focuses the button with this label inside `scope`. */
function focusButton(page: Page, label: string, scope = ".pane-panel") {
  return page.evaluate(
    (l: string, s: string) => {
      [...document.querySelectorAll<HTMLButtonElement>(`${s} button`)]
        .find((b) => b.textContent?.trim() === l)!
        .focus();
    },
    label,
    scope,
  );
}

browserTest(
  "the header fits every screen and keeps all navigation reachable",
  {
    seed: true,
    session: {
      ...MANAGER_SESSION,
      user: { ...MANAGER_SESSION.user!, role: "administrator" },
    },
    intercept: async (request, next) => {
      if (!new URL(request.url).pathname.endsWith("/project")) return undefined;
      const project = await serverJson<ProjectInfo>(request, next);
      return Response.json({ ...project, name: "A world of words and a very long project name" });
    },
  },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/activity", (page) =>
      page.setViewport({ width: 1440, height: 900 }),
    );
    await waitFor(page, () => document.querySelector(".user-name") !== null);
    const headerFits = () =>
      page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".header")!;
        const navigation = header.querySelector<HTMLElement>(".nav")!;
        return (
          header.scrollWidth <= header.clientWidth &&
          navigation.scrollWidth <= navigation.clientWidth &&
          header.getBoundingClientRect().right <= innerWidth
        );
      });
    assert(await headerFits());
    await page.focus(".nav-overflow button");
    await press(page, "Enter");
    assertEquals(await focused(page), "A:Source issues");
    await press(page, "Escape");
    assert(await page.$eval(".nav-overflow button", (button) => button === document.activeElement));
    assertEquals(await page.$(".nav .menu"), null);
    await page.click(".theme-menu button");
    await page.click('.theme-menu input[value="dark"]');
    assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    await page.click('.theme-menu input[value="system"]');
    assertEquals(await page.evaluate(() => localStorage.getItem("quaso.theme")), null);
    await press(page, "Escape");
    assert(await page.$eval(".theme-menu button", (button) => button === document.activeElement));

    await page.setViewport({ width: 360, height: 800 });
    assert(await headerFits());
    await page.click(".nav-overflow button");
    assertEquals(
      await page.$$eval(".nav .menu a", (links) => links.map((link) => link.textContent?.trim())),
      [
        "Dashboard",
        "Sources",
        "Activity",
        "Glossary",
        "Source issues",
        "Review queue",
        "My contributions",
        "Jobs",
        "Usage",
        "Team",
        "Settings",
        "Admin",
      ],
    );
    assert(
      await page.$eval(".nav .menu", (menu) => {
        const box = menu.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      }),
    );
    await page.click('.nav .menu a[href="/glossary"]');
    await waitFor(page, () => location.pathname === "/glossary");
    assertEquals(await page.$(".nav .menu"), null);
    await page.click(".user-button");
    await press(page, "Escape");
    assert(await page.$eval(".user-button", (button) => button === document.activeElement));

    await page.setViewport({ width: 1440, height: 1000 });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    assert(await headerFits(), "The header must also fit enlarged text");
    assertEquals(problems, []);
  },
);

browserTest(
  "a busy button keeps focus, during the action and after it fails",
  {
    seed: true,
    session: MANAGER_SESSION,
    intercept: async (request) => {
      if (request.method !== "PUT") return undefined;
      await sleep(400);
      return apiError(500, "internal", "The disk is full.");
    },
  },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "fr", "&state=untranslated");
    const tab = await openTab(browser, server, `/translate/fr?id=${strings[0].id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.focus(),
    );
    await page.keyboard.type("Bonjour");
    await focusButton(page, "Save", ".panel-actions");
    await press(page, "Enter");
    // Busy: announced as busy, still focused, and a second press does nothing.
    await waitFor(page, () => document.activeElement?.getAttribute("aria-busy") === "true");
    assertEquals(await focused(page), "BUTTON:Save");
    await waitFor(
      page,
      () =>
        document
          .querySelector('.pane-panel [role="alert"]')
          ?.textContent?.includes("The disk is full.") ?? false,
    );
    assertEquals(await focused(page), "BUTTON:Save");
    assertEquals(
      tab.problems.filter((p) => !/status of 500 .*\/translations\/fr\)$/.test(p)),
      [],
    );
  },
);

browserTest(
  "after Approve or Delete removes their button, focus goes to the translation input",
  {
    seed: true,
    session: MANAGER_SESSION,
    intercept: (() => {
      const state = { approved: false, deleted: false };
      return async (request: Request, next: (request: Request) => Promise<Response>) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname.endsWith("/approve")) {
          state.approved = true;
          return Response.json({});
        }
        if (request.method === "DELETE" && url.pathname.includes("/translations/")) {
          state.deleted = true;
          return Response.json({});
        }
        // Afterwards the string reads as the action left it.
        if (
          request.method === "GET" &&
          /^\/api\/v1\/strings\/\d+$/.test(url.pathname) &&
          (state.approved || state.deleted)
        ) {
          const detail = await serverJson<StringDetail>(request, next);
          if (state.deleted) detail.translation = null;
          else if (detail.translation) detail.translation.colour = "blue";
          return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
        }
        return undefined;
      };
    })(),
  },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "pl", "&state=green");
    const target = strings.find((s) => s.kind === "text")!;
    const tab = await openTab(browser, server, `/translate/pl?id=${target.id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);

    await focusButton(page, "Approve", ".panel-actions");
    await press(page, "Enter");
    await waitFor(
      page,
      () =>
        ![...document.querySelectorAll(".panel-actions button")].some(
          (b) => b.textContent?.trim() === "Approve",
        ),
    );
    await waitFor(page, () => document.activeElement?.id === "translation-text");

    // Delete, confirmed in the dialog: the button that opened it is gone once it closes.
    await focusButton(page, "Delete", ".panel-actions");
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector("dialog[open]") !== null);
    assertEquals(await focused(page), "BUTTON:Keep it");
    await focusButton(page, "Delete", "dialog[open]");
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector("dialog[open]") === null);
    await waitFor(page, () => document.querySelector(".pane-panel .translation-text") === null);
    await waitFor(page, () => document.activeElement?.id === "translation-text");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "on a narrow screen, the files overlay closes when focus leaves it, never hiding focus",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/translate/de", (page) =>
      page.setViewport({ width: 900, height: 800 }),
    );
    const { page } = tab;
    await waitFor(page, () => document.querySelectorAll(".string-list [data-index]").length > 0);
    await page.evaluate(() => document.getElementById("files-toggle")!.focus());
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector("#editor-files.is-open") !== null);
    assertEquals(
      await page.evaluate(() => document.activeElement?.classList.contains("tree-all")),
      true,
    );
    // Tab through the files and out: whatever has focus is visible, not under the overlay.
    for (let i = 0; i < 6; i++) {
      await press(page, "Tab");
      const report = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const box = element.getBoundingClientRect();
        const x = box.left + Math.min(box.width / 2, 8);
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        const visible =
          hit !== null &&
          (element.contains(hit) ||
            hit.contains(element) ||
            element.closest("label")?.contains(hit) === true);
        return {
          inFiles: document.getElementById("editor-files")!.contains(element),
          open: document.getElementById("editor-files")!.classList.contains("is-open"),
          visible,
          what: element.getAttribute("aria-label") ?? element.textContent?.slice(0, 30),
        };
      });
      if (report.inFiles) continue;
      assertEquals(report.open, false, `the overlay stayed open over ${report.what}`);
      assert(report.visible, `${report.what} is hidden`);
    }
    assertEquals(
      await page.evaluate(() =>
        document.getElementById("editor-files")!.contains(document.activeElement),
      ),
      false,
    );
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "moving up a long file tree keeps the focused file clear of the sticky header",
  {
    seed: true,
    intercept: async (request, next) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/v1/files") return undefined;
      const real = await serverJson<FilesResult>(request, next);
      const files = Array.from({ length: 60 }, (_, i) => ({
        ...real.files[0],
        path: `level-${String(i).padStart(2, "0")}.json`,
        repoPath: `level-${String(i).padStart(2, "0")}.json`,
      }));
      return Response.json({ ...real, files }, { headers: { "Cache-Control": "no-store" } });
    },
  },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/languages/de", (page) =>
      page.setViewport({ width: 1280, height: 700 }),
    );
    const { page } = tab;
    await waitFor(page, () => document.querySelectorAll('[role="treeitem"]').length === 60);
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')!.focus(),
    );
    await press(page, "End");
    await waitFor(
      page,
      () => document.activeElement?.getAttribute("data-path") === "level-59.json",
    );
    const hidden: string[] = [];
    for (let i = 0; i < 40; i++) {
      await press(page, "ArrowUp");
      await sleep(30);
      const report = await page.evaluate(() => {
        const header = document.querySelector(".header")!.getBoundingClientRect();
        const row = document.activeElement!.querySelector(".tree-row")!.getBoundingClientRect();
        return {
          path: document.activeElement!.getAttribute("data-path"),
          top: row.top,
          header: header.bottom,
        };
      });
      if (report.top < report.header) {
        hidden.push(`${report.path} at ${report.top} < ${report.header}`);
      }
    }
    assertEquals(hidden, []);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "the checks' live region is in the accessibility tree before its first message",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const score = (await getStrings(server, "fr", "&q=gameOver.score")).strings.find(
      (s) => s.key === "gameOver.score",
    )!;
    const tab = await openTab(browser, server, `/translate/fr?id=${score.id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector("#translation-text") !== null);
    const celestial = await page.createCDPSession();
    await celestial.send("Accessibility.enable");
    const liveRegion = async () => {
      const { root } = await celestial.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await celestial.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#translation-text-checks",
      });
      const { nodes } = await celestial.send("Accessibility.getPartialAXTree", {
        nodeId,
        fetchRelatives: false,
      });
      const node = nodes[0];
      return {
        ignored: node?.ignored,
        live: node?.properties?.find((p) => p.name === "live")?.value.value,
        text: await text(page, "#translation-text-checks"),
      };
    };
    const before = await liveRegion();
    assertEquals([before.ignored, before.live, before.text], [false, "polite", ""]);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>("#translation-text")!;
      input.focus();
      input.select();
    });
    await page.keyboard.type("x ");
    await waitFor(
      page,
      () =>
        document.querySelector("#translation-text-checks")?.textContent?.includes("{{score}}") ??
        false,
    );
    const after = await liveRegion();
    assertEquals([after.ignored, after.live], [false, "polite"]);
    assertStringIncludes(after.text, "Error:");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "a toast waits while it has focus, and focus goes back when it is dismissed",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "de");
    const last = strings[strings.length - 1];
    const tab = await openTab(browser, server, `/translate/de?id=${last.id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".string-row.is-current .row-link") !== null);
    await page.evaluate(() =>
      document.querySelector<HTMLElement>(".string-row.is-current .row-link")!.focus(),
    );
    await press(page, "ArrowDown", ["Alt"]);
    await waitFor(page, () => document.querySelector(".toast") !== null);
    assertStringIncludes(await text(page, ".toast"), "That was the last string.");
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('.toast button[aria-label="Dismiss"]')!.focus(),
    );
    await sleep(6_000);
    assertEquals(await page.evaluate(() => document.querySelectorAll(".toast").length), 1);
    assertEquals(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Dismiss",
    );
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector(".toast") === null);
    await waitFor(page, () => document.activeElement?.classList.contains("row-link") ?? false);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "targets and cues: row checkboxes are large enough, and the current page isn't only a colour",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/translate/de");
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".string-list .row-check") !== null);
    const target = await page.evaluate(() => {
      const box = document.querySelector(".row-check-target")!.getBoundingClientRect();
      const check = document.querySelector(".row-check")!.getBoundingClientRect();
      const link = document.querySelector(".string-list .row-link")!.getBoundingClientRect();
      return { width: box.width, height: box.height, gap: link.left - check.right };
    });
    assert(target.width >= 44 && target.height >= 44, JSON.stringify(target));
    // Tapping the checkbox's padding must not activate the adjacent link.
    assert(target.gap >= 4, JSON.stringify(target));
    // Clicking beside the checkbox checks it.
    await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>(".row-check-target")!;
      box.click();
    });
    await waitFor(page, () => document.querySelector(".bulk-bar") !== null);

    await page.goto(`${server.url}/activity`, { waitUntil: "networkidle0" });
    await waitFor(page, () => document.querySelector('.nav-link[aria-current="page"]') !== null);
    const styles = await page.evaluate(() => {
      const pick = (e: Element) => {
        const style = getComputedStyle(e);
        return { weight: Number(style.fontWeight), shadow: style.boxShadow };
      };
      return {
        current: pick(document.querySelector('.nav-link[aria-current="page"]')!),
        other: pick(document.querySelector(".nav-link:not([aria-current])")!),
      };
    });
    assert(styles.current.weight > styles.other.weight, JSON.stringify(styles));
    assertEquals(styles.other.shadow, "none");
    assertEquals(styles.current.shadow, "none");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "filtering languages or files says how many match, as a status",
  { seed: true },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/");
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".language-row") !== null);
    assertEquals(await text(page, '.languages-card [role="status"]'), "6 languages");
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>("#language-search")!.focus(),
    );
    await page.keyboard.type("pol");
    await waitFor(
      page,
      () =>
        document.querySelector('.languages-card [role="status"]')?.textContent ===
        "1 of 6 languages match “pol”.",
    );
    await page.keyboard.type("xyz");
    await waitFor(
      page,
      () =>
        document.querySelector('.languages-card [role="status"]')?.textContent ===
        "No language matches “polxyz”.",
    );

    await page.goto(`${server.url}/languages/de`, { waitUntil: "networkidle0" });
    await waitFor(
      page,
      () => document.querySelectorAll('[role="treeitem"][aria-selected]').length === 3,
    );
    assertEquals(await text(page, 'main [role="status"]'), "3 files");
    await page.evaluate(() => document.querySelector<HTMLInputElement>("#file-filter")!.focus());
    await page.keyboard.type("menu");
    await waitFor(
      page,
      () => document.querySelector('main [role="status"]')?.textContent === "1 of 3 files shown.",
    );
    await page.keyboard.type("zzz");
    await waitFor(
      page,
      () =>
        document.querySelector('main [role="status"]')?.textContent ===
        "No file matches the filter.",
    );
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "“Show older activity”: focus stays on it while it loads, then moves to what's new when it goes",
  {
    seed: true,
    intercept: async (request, next) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/v1/activity") return undefined;
      const cursor = url.searchParams.get("cursor");
      const first = new URL(url);
      first.search = "";
      const real = await serverJson<ActivityResult>(request, next, first);
      const item = (n: number) => ({ ...real.items[0], id: `older-${n}`, summary: `Older ${n}` });
      if (cursor === null) return Response.json({ ...real, nextCursor: "page-2" });
      await sleep(300);
      return cursor === "page-2"
        ? Response.json({ items: [item(1), item(2)], nextCursor: "page-3" })
        : Response.json({ items: [item(3), item(4)], nextCursor: null });
    },
  },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/activity");
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".load-more button") !== null);
    await page.evaluate(() => document.querySelector<HTMLElement>(".load-more button")!.focus());
    await press(page, "Enter");
    await waitFor(page, () => document.activeElement?.getAttribute("aria-busy") === "true");
    await waitFor(page, () => document.querySelector('[data-id="older-2"]') !== null);
    assertEquals(await focused(page), "BUTTON:Show older activity");
    // The last page: the button goes, and focus moves to the first item it loaded.
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector(".load-more") === null);
    await waitFor(page, () => document.activeElement?.getAttribute("data-id") === "older-3");
    assertEquals(tab.problems, []);
  },
);
