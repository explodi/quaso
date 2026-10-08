// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
/**
 * The editor's data in a browser: the string list and the panel keep up with other people's
 * changes (the list keeps every loaded string in place; changes reach anonymous visitors,
 * whose answers the browser may cache), failed searches say so, the selection follows the
 * filters, addresses keep what they say, and conflicts on actions retry the action.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Page } from "puppeteer";
import type { ProjectInfo, StringsPage } from "@quaso/core";
import {
  apiError,
  browserTest,
  getStrings,
  type Intercept,
  MANAGER_SESSION,
  openTab,
  pagePath,
  press,
  text,
  waitFor,
} from "./_setup.ts";

/** The project's answers aren't cached, so a focus shows its new revision at once. */
const uncachedProject: Intercept = async (request, next) => {
  if (new URL(request.url).pathname !== "/api/v1/project") return undefined;
  const response = await next(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
};

/** What the page gets when the window gets focus again. */
function focusWindow(page: Page) {
  return page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
  });
}

function waitForPanel(page: Page, key: string) {
  return waitFor(
    page,
    (k: string) => document.querySelector(".panel-key code")?.textContent === k,
    [key],
  );
}

/** How many strings the list has loaded (its rows are 60 px high). */
function loadedRows(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.round(document.querySelector<HTMLElement>(".vlist-inner")!.offsetHeight / 60),
  );
}

const listRequests: string[] = [];

browserTest(
  "fetching the list again keeps every loaded string, the scroll position and the next string",
  {
    session: MANAGER_SESSION,
    intercept: (request, next) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/strings" && !url.searchParams.has("ids")) {
        listRequests.push(url.search);
      }
      return uncachedProject(request, next);
    },
  },
  async ({ server, browser }) => {
    const keys = Array.from({ length: 1_200 }, (_, i) => `k${String(i).padStart(4, "0")}`);
    const content = JSON.stringify(Object.fromEntries(keys.map((key, i) => [key, `Text ${i}`])));
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "big.json", repoPath: "big.json", content }],
        sourceLanguage: "en",
        languages: ["de"],
      }),
    });
    const tab = await openTab(browser, server, "/translate/de?order=file");
    const { page } = tab;
    await waitFor(page, () => document.querySelectorAll(".string-list [data-index]").length > 0);
    // Scroll until every string is loaded, 200 at a time.
    await page.evaluate(async () => {
      const list = document.querySelector<HTMLElement>(".string-list")!;
      for (let i = 0; i < 200; i++) {
        list.scrollTop = list.scrollHeight;
        await new Promise((done) => setTimeout(done, 50));
        if (list.scrollHeight >= 1_200 * 60) break;
      }
    });
    await waitFor(
      page,
      () => document.querySelector<HTMLElement>(".vlist-inner")!.offsetHeight === 1_200 * 60,
    );
    // Open k1005.
    await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".string-list")!;
      list.scrollTop = 1_005 * 60 - 120;
    });
    await waitFor(page, () => document.querySelector('[data-index="1005"] .row-link') !== null);
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('[data-index="1005"] .row-link')!.click(),
    );
    await waitForPanel(page, "k1005");
    const scrollTop = await page.evaluate(
      () => document.querySelector<HTMLElement>(".string-list")!.scrollTop,
    );

    // Coming back to the window doesn't fetch the list again: the project's revision says
    // whether anything changed.
    await new Promise((done) => setTimeout(done, 5_500));
    let before = listRequests.length;
    await focusWindow(page);
    await new Promise((done) => setTimeout(done, 700));
    assertEquals(listRequests.slice(before), []);
    assertEquals(await loadedRows(page), 1_200);

    // Someone else changes a translation: the list is fetched again, all 1,200 strings of it,
    // 500 at a time, and stays where it was.
    await server.api("/imports", {
      method: "POST",
      body: JSON.stringify({
        language: "de",
        as: "green",
        files: [{ path: "big.json", content: JSON.stringify({ k0001: "Text eins" }) }],
      }),
    });
    await new Promise((done) => setTimeout(done, 5_500));
    before = listRequests.length;
    await focusWindow(page);
    const deadline = Date.now() + 10_000;
    while (listRequests.length < before + 3 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    await new Promise((done) => setTimeout(done, 300));
    const refetch = listRequests
      .slice(before)
      .map((search) => new URLSearchParams(search).get("limit"));
    assertEquals(refetch, ["500", "500", "200"]);
    assertEquals(await loadedRows(page), 1_200);
    assertEquals(
      await page.evaluate(() => document.querySelector<HTMLElement>(".string-list")!.scrollTop),
      scrollTop,
    );
    assertEquals(
      await page.evaluate(() =>
        document.querySelector('[data-index="1005"] .string-row')?.classList.contains("is-current"),
      ),
      true,
    );
    // The next string is still the one after k1005.
    await press(page, "ArrowDown", ["Alt"]);
    await waitForPanel(page, "k1006");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "anonymous visitors see other people's translations once the revision changes",
  { seed: true, intercept: uncachedProject },
  async ({ server, browser }) => {
    const title = (await getStrings(server, "ja", "&q=main.title")).strings.find(
      (s) => s.key === "main.title",
    )!;
    assertEquals(title.translation, null);
    const tab = await openTab(browser, server, `/translate/ja?id=${title.id}`);
    const { page } = tab;
    await waitFor(
      page,
      () =>
        document.querySelector(".pane-panel")?.textContent?.includes("Not translated yet") ?? false,
    );
    // The browser has the string and the list from public, cacheable answers.
    const cacheControl = await page.evaluate(
      (id: number) =>
        fetch(`/api/v1/strings/${id}?language=ja`).then((r) => r.headers.get("cache-control")),
      title.id,
    );
    assertStringIncludes(cacheControl ?? "", "max-age");

    const translated = "クアソ・クエスト";
    await server.api("/imports", {
      method: "POST",
      body: JSON.stringify({
        language: "ja",
        as: "green",
        files: [
          {
            path: "menus.json",
            content: JSON.stringify({ main: { title: translated } }),
          },
        ],
      }),
    });
    // The revision shows the change; what was fetched again comes from the server, not the
    // browser's cached answers.
    await new Promise((done) => setTimeout(done, 5_500));
    await focusWindow(page);
    await waitFor(
      page,
      (value: string) =>
        document.querySelector(".pane-panel .translation-text")?.textContent === value,
      [translated],
    );
    // And the list shows it green.
    await waitFor(
      page,
      () => document.querySelector(".string-row.is-current .state-marker .state-green") !== null,
    );
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "a search that fails says so, instead of showing the previous strings",
  {
    seed: true,
    session: MANAGER_SESSION,
    intercept: (request) => {
      const url = new URL(request.url);
      // The editor searches through /strings/queue (queue order) or /strings.
      const listsStrings = url.pathname.startsWith("/api/v1/strings");
      if (listsStrings && url.searchParams.get("q") === "boom") {
        return apiError(500, "internal", "Something broke.");
      }
      return undefined;
    },
  },
  async ({ server, browser }) => {
    const all = await getStrings(server, "de");
    const tab = await openTab(browser, server, "/translate/de");
    const { page } = tab;
    await waitFor(page, () => document.querySelectorAll(".string-list [data-index]").length > 0);
    // The search box takes no more than the API does.
    assertEquals(
      await page.evaluate(
        () => document.querySelector<HTMLInputElement>("#string-search")!.maxLength,
      ),
      200,
    );
    await page.evaluate(() => document.querySelector<HTMLInputElement>("#string-search")!.focus());
    await page.keyboard.type("boom");
    await waitFor(
      page,
      () =>
        document
          .querySelector('.pane-strings [role="alert"]')
          ?.textContent?.includes("Something broke.") ?? false,
    );
    assertEquals(await page.evaluate(() => document.querySelectorAll(".string-list").length), 0);
    assertEquals(await text(page, ".strings-status p"), "The strings couldn't be loaded.");
    // Nothing is left to select for bulk actions.
    assertEquals(
      await page.evaluate(
        () => document.querySelector<HTMLInputElement>(".select-all input")!.disabled,
      ),
      true,
    );
    assert(all.total > 0);
    assertEquals(
      tab.problems.filter((p) => !/status of 500 .*q=boom/.test(p)),
      [],
    );
  },
);

browserTest(
  "the selection belongs to what the list shows: another file clears it",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const green = await getStrings(server, "pl", "&file=common.json&state=green");
    assert(green.total > 1);
    const tab = await openTab(browser, server, "/translate/pl?file=common.json&state=green");
    const { page } = tab;
    await waitFor(
      page,
      (n: number) =>
        document.querySelector(".strings-status")?.textContent?.includes(`${n} strings`) ?? false,
      [green.total],
    );
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>(".select-all input")!.click(),
    );
    await waitFor(
      page,
      (n: number) =>
        document.querySelector(".bulk-bar")?.textContent?.includes(`${n} strings selected`) ??
        false,
      [green.total],
    );
    await page.evaluate(() =>
      document
        .querySelector<HTMLElement>('.pane-files [data-path="menus.json"] .tree-name')!
        .click(),
    );
    await waitFor(page, () => location.search.includes("file=menus.json"));
    await waitFor(page, () => document.querySelector(".bulk-bar") === null);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "addresses keep what they say: a file in the path keeps ?id=, and a tag's spelling doesn't remount the editor",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    const again = (await getStrings(server, "de", "&q=playAgain")).strings.find(
      (s) => s.key === "main.playAgain",
    )!;
    const tab = await openTab(browser, server, `/translate/de/menus.json?id=${again.id}`);
    const { page } = tab;
    await waitFor(page, () => location.pathname === "/translate/de");
    const query = await page.evaluate(() =>
      Object.fromEntries(new URLSearchParams(location.search)),
    );
    assertEquals(query, { id: String(again.id), file: "menus.json" });
    await waitForPanel(page, "main.playAgain");

    // pt-br is pt-BR: the address changes once, at once, and then the editor stays put.
    await page.goto(`${server.url}/translate/pt-br`, { waitUntil: "networkidle0" });
    await waitFor(page, () => location.pathname === "/translate/pt-BR");
    await waitFor(page, () => document.querySelectorAll(".string-list [data-index]").length > 4);
    await page.evaluate(() => {
      (document.querySelector(".editor") as unknown as { marked: boolean }).marked = true;
      document.querySelector<HTMLInputElement>('[data-index="0"] .row-check')!.click();
    });
    await waitFor(page, () => document.querySelector(".bulk-bar") !== null);
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('[data-index="1"] .row-check')!.click(),
    );
    await waitFor(
      page,
      () =>
        document.querySelector(".bulk-bar")?.textContent?.includes("2 strings selected") ?? false,
    );
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('[data-index="3"] .row-link')!.click(),
    );
    await waitFor(
      page,
      () => document.querySelector('[data-index="3"] .string-row.is-current') !== null,
    );
    assertEquals(
      await page.evaluate(
        () => (document.querySelector(".editor") as unknown as { marked?: boolean }).marked,
      ),
      true,
    );
    assertStringIncludes(await text(page, ".bulk-bar"), "2 strings selected");
    assertEquals(await pagePath(page).then((path) => path.split("?")[0]), "/translate/pt-BR");
    assertEquals(tab.problems, []);
  },
);

/** A translation as the API describes it, changed by someone else. */
function theirs(value: string, revision: number) {
  return {
    value,
    colour: "green",
    outdated: false,
    revision,
    qa: { errors: 0, warnings: 0 },
    author: { type: "user", id: 2, name: "Ana" },
    approver: null,
    updatedAt: Date.now() - 60_000,
  };
}

const writes: { method: string; path: string; body: unknown }[] = [];

browserTest(
  "a conflict on Delete or Approve retries that action on their version, never saves the old text",
  {
    seed: true,
    session: MANAGER_SESSION,
    intercept: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET") return undefined;
      if (!url.pathname.startsWith("/api/v1/strings/")) return undefined;
      const body = await request.text().then((t) => (t ? JSON.parse(t) : undefined));
      writes.push({ method: request.method, path: url.pathname, body });
      const attempt = writes.filter(
        (w) => w.method === request.method && w.path === url.pathname,
      ).length;
      if (request.method === "DELETE") {
        return attempt === 1
          ? apiError(409, "conflict", "Changed meanwhile.", {
              current: theirs("Their newer text", 9),
            })
          : Response.json({}, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname.endsWith("/approve")) {
        // A 409 without the current translation: the website asks for it.
        return apiError(409, "conflict", "Changed meanwhile.");
      }
      return apiError(500, "internal", `Unexpected ${request.method} ${url.pathname}`);
    },
  },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "pl", "&state=green");
    const target = strings.find((s) => s.key === "appName") ?? strings[0];
    const tab = await openTab(browser, server, `/translate/pl?id=${target.id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    /** Clicks the button with this label inside `scope`. */
    const button = (label: string, scope = ".pane-panel") =>
      page.evaluate(
        (l: string, s: string) => {
          [...document.querySelectorAll<HTMLButtonElement>(`${s} button`)]
            .find((b) => b.textContent?.trim() === l)!
            .click();
        },
        label,
        scope,
      );

    await button("Delete", ".panel-actions");
    await waitFor(page, () => document.querySelector("dialog[open]") !== null);
    await button("Delete", "dialog[open]");
    await waitFor(
      page,
      () =>
        document
          .querySelector('.pane-panel .notice-warning[role="alert"]')
          ?.textContent?.includes("Their newer text") ?? false,
    );
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.pane-panel .notice-warning[role="alert"] button')].map((b) =>
        b.textContent?.trim(),
      ),
    );
    assertEquals(labels, ["Reload", "Delete their version"]);
    await button("Delete their version", ".notice-warning");
    await waitFor(page, () => document.querySelector(".pane-panel .notice-warning") === null);
    assertEquals(
      writes.map((w) => [w.method, (w.body as { baseRevision?: number })?.baseRevision]),
      [
        ["DELETE", target.translation!.revision],
        ["DELETE", 9],
      ],
    );

    // Approve meets a conflict whose answer lacks the current translation: the website
    // fetches it, rather than claiming it was deleted.
    writes.length = 0;
    await page.goto(`${server.url}/translate/pl?id=${target.id}`, { waitUntil: "networkidle0" });
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    await button("Approve", ".panel-actions");
    await waitFor(
      page,
      () =>
        document
          .querySelector('.pane-panel .notice-warning[role="alert"]')
          ?.textContent?.includes("Their version") ?? false,
    );
    const notice = await text(page, '.pane-panel .notice-warning[role="alert"]');
    assert(!notice.includes("deleted"), notice);
    assertStringIncludes(notice, "Approve their version");
    assert(!notice.includes("Save mine over it"), notice);
    assertEquals(
      writes.map((w) => w.method),
      ["POST"],
    );
    assertEquals(
      tab.problems.filter((p) => !/status of 409 /.test(p)),
      [],
    );
  },
);

browserTest(
  "right-to-left English: a Hebrew source shows right to left in the panel and the list",
  { session: MANAGER_SESSION },
  async ({ server, browser }) => {
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [
          {
            path: "common.json",
            repoPath: "common.json",
            content: JSON.stringify({
              greeting: "שלום {{name}}, ברוך הבא!",
              coins_one: "מטבע אחד",
              coins_other: "{{count}} מטבעות",
            }),
          },
        ],
        sourceLanguage: "he",
        languages: ["en", "ar"],
      }),
    });
    const project = await server.api<ProjectInfo>("/project");
    assertEquals(project.sourceLanguage, "he");
    const { strings } = await server.api<StringsPage>("/strings?language=en");
    const coins = strings.find((s) => s.key === "coins")!;
    const tab = await openTab(browser, server, `/translate/en?id=${coins.id}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelectorAll(".pane-panel textarea").length === 2);
    const directions = await page.evaluate(() =>
      [
        ...document.querySelectorAll(".source-forms dd, .input-english, .string-list .row-source"),
      ].map((e) => `${e.getAttribute("lang")}:${getComputedStyle(e).direction}`),
    );
    assert(directions.length >= 5, JSON.stringify(directions));
    for (const direction of directions) assertEquals(direction, "he:rtl");
    // The English inputs stay left to right.
    assertEquals(
      await page.evaluate(
        () => document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.dir,
      ),
      "ltr",
    );
    const greeting = strings.find((s) => s.key === "greeting")!;
    await page.goto(`${server.url}/translate/en?id=${greeting.id}`, { waitUntil: "networkidle0" });
    await waitForPanel(page, "greeting");
    assertEquals(
      await page.evaluate(() => {
        const source = document.querySelector(".pane-panel .source")!;
        return `${source.getAttribute("lang")}:${getComputedStyle(source).direction}`;
      }),
      "he:rtl",
    );
    assertEquals(tab.problems, []);
  },
);
