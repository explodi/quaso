// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
/** LATER-1 to LATER-3 through real accounts, service writes and the rendered website. */
import { assert, assertEquals, assertStringIncludes } from "@quaso/runtime/assert";
import type { Page } from "puppeteer";
import { ANONYMOUS, type Service, SYSTEM } from "@quaso/service";
import {
  browserTest,
  getStrings,
  openTab,
  press,
  type TestServer,
  text,
  waitFor,
} from "./_setup.ts";

const PASSWORD = "correct horse battery";
const OWNER = "owner@example.com";
const HELPER = "helper@example.com";
async function prepare(service: Service) {
  const { token } = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: token!,
    email: OWNER,
    password: PASSWORD,
    displayName: "Project Owner",
    projectName: "Community Project",
  });
  await service.addLanguage(SYSTEM, { tag: "de" });
  const { user } = await service.signUp(ANONYMOUS, {
    email: HELPER,
    password: PASSWORD,
    displayName: "Helpful Visitor",
  });
  await service.requestVolunteer(
    { type: "user", userId: user.id },
    {
      languages: ["de"],
      message: "Happy to help",
    },
  );
  await service.upload(SYSTEM, {
    files: [
      {
        path: "common.json",
        repoPath: "common.json",
        content: JSON.stringify({ play: "Play Quaso", quiet: "An endgame" }),
      },
    ],
    languages: ["de"],
  });
}
async function fill(page: Page, name: string, value: string) {
  await page.evaluate((name: string) => {
    const label = [...document.querySelectorAll<HTMLLabelElement>("label")].find(
      (l) => l.textContent?.trim() === name,
    );
    const input = label?.htmlFor
      ? document.getElementById(label.htmlFor)
      : label?.querySelector("input,textarea");
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
      throw new Error(`No input for ${name}`);
    }
    input.focus();
    input.select();
  }, name);
  await page.keyboard.type(value);
}
async function click(page: Page, name: string, scope = "") {
  await page.evaluate(
    (name: string, scope: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
        (b) => b.textContent?.trim() === name,
      );
      if (!button) throw new Error(`No button ${name}`);
      button.click();
    },
    name,
    scope,
  );
}
async function signIn(page: Page, server: TestServer, email: string) {
  await page.goto(`${server.url}/signin`, { waitUntil: "networkidle0" });
  await fill(page, "Email address", email);
  await fill(page, "Password", PASSWORD);
  await click(page, "Sign in", "main");
  await waitFor(page, () => document.querySelector(".user-name") !== null);
}
async function signOut(page: Page) {
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/signout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
}

browserTest(
  "glossary: managers edit, visitors search, editor hints are keyboard accessible and QA warns",
  { prepare },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/glossary");
    assertStringIncludes(await text(tab.page, "main"), "No glossary terms yet");
    assertEquals(
      await tab.page.evaluate(() =>
        [...document.querySelectorAll("main button")].some((b) => b.textContent === "Add term"),
      ),
      false,
    );
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/glossary`, { waitUntil: "networkidle0" });
    await click(tab.page, "Add term");
    await fill(tab.page, "English term", "Play");
    await fill(tab.page, "Translation", "Spielen");
    await fill(tab.page, "Note (optional)", "Use for the main action");
    await click(tab.page, "Save term");
    await waitFor(tab.page, () => document.querySelector("dialog[open]") === null);
    assertStringIncludes(await text(tab.page, ".glossary-list"), "Spielen");
    await click(tab.page, "Edit term");
    await fill(tab.page, "Note (optional)", "Main menu action");
    await click(tab.page, "Save term");
    await waitFor(tab.page, () =>
      document.querySelector(".glossary-list")?.textContent?.includes("Main menu action"),
    );
    await fill(tab.page, "Search glossary", "missing");
    await waitFor(tab.page, () =>
      document.querySelector("main")?.textContent?.includes("No terms match"),
    );
    const id = (await getStrings(server, "de")).strings.find((s) => s.key === "play")!.id;
    await tab.page.goto(`${server.url}/translate/de?id=${id}`, { waitUntil: "networkidle0" });
    await waitFor(tab.page, () => document.querySelector(".glossary-highlight") !== null);
    const tooltip = await tab.page.evaluate(() => {
      const hint = document.querySelector<HTMLElement>(".glossary-highlight")!;
      hint.focus();
      const tip = document.getElementById(hint.getAttribute("aria-describedby")!)!;
      return {
        focused: document.activeElement === hint,
        text: tip.textContent,
        visible: getComputedStyle(tip).display !== "none",
      };
    });
    assert(tooltip.focused && tooltip.visible);
    assertStringIncludes(tooltip.text!, "Spielen");
    await press(tab.page, "Escape");
    await click(tab.page, "Glossary", '[role="tablist"]');
    assertStringIncludes(await text(tab.page, ".glossary-definitions"), "Spielen");
    await tab.page.evaluate(() => {
      const field = document.querySelector<HTMLTextAreaElement>("[data-translation-input]")!;
      field.focus();
      field.select();
    });
    await tab.page.keyboard.type("Starten");
    await waitFor(tab.page, () =>
      document.querySelector(".checks")?.textContent?.includes("glossary term"),
    );
    assertEquals(
      await tab.page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (b) => b.textContent?.trim() === "Save",
          )?.disabled ?? false,
      ),
      false,
    );
    await signOut(tab.page);
    await tab.page.goto(`${server.url}/glossary?q=menu`, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(tab.page, ".glossary-list"), "Play");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "comments: a pending volunteer reports English, public reads it and a manager resolves the issue",
  { prepare },
  async ({ server, browser }) => {
    const id = (await getStrings(server, "de")).strings.find((s) => s.key === "play")!.id;
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, HELPER);
    await tab.page.goto(`${server.url}/translate/de?id=${id}`, { waitUntil: "networkidle0" });
    await click(tab.page, "Comments", '[role="tablist"]');
    await fill(tab.page, "Comment", "Does Play mean start a game?");
    await tab.page.evaluate(() => {
      const label = [...document.querySelectorAll("label")].find((l) =>
        l.textContent?.includes("Problem in the English"),
      )!;
      label.querySelector<HTMLInputElement>("input")!.click();
    });
    await click(tab.page, "Post comment");
    await waitFor(tab.page, () =>
      document
        .querySelector(".comment-record")
        ?.textContent?.includes("Does Play mean start a game?"),
    );
    await signOut(tab.page);
    await tab.page.goto(`${server.url}/translate/de?id=${id}`, { waitUntil: "networkidle0" });
    await click(tab.page, "Comments", '[role="tablist"]');
    await waitFor(tab.page, () => document.querySelector(".comment-record") !== null);
    assertStringIncludes(await text(tab.page, ".comments-panel"), "Does Play mean start a game?");
    assertEquals(
      await tab.page.evaluate(() => document.querySelector(".comment-form") === null),
      true,
    );
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/issues`, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(tab.page, ".comment-record"), "common.json · play");
    assertEquals(
      await tab.page.evaluate(
        (id: number) =>
          document
            .querySelector<HTMLAnchorElement>(".comment-record h3 a")
            ?.href.includes(`id=${id}`),
        id,
      ),
      true,
    );
    await click(tab.page, "Resolve", ".comment-record");
    await waitFor(tab.page, () =>
      document.querySelector("main")?.textContent?.includes("No unresolved problems"),
    );
    await tab.page.goto(`${server.url}/translate/de?id=${id}`, { waitUntil: "networkidle0" });
    await click(tab.page, "Comments", '[role="tablist"]');
    await waitFor(tab.page, () =>
      document.querySelector(".comment-record")?.textContent?.includes("Resolved by Project Owner"),
    );
    assertStringIncludes(await text(tab.page, ".comment-record"), "Resolved by Project Owner");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "language requests: signed-in visitors request and vote; administrators approve and reject in Settings",
  {
    async prepare(service) {
      await prepare(service);
      await service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
    },
  },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, HELPER);
    await click(tab.page, "Request a language");
    await fill(tab.page, "Search languages", "português");
    await tab.page.select("dialog[open] select", "pt-BR");
    await fill(tab.page, "Message (optional)", "Brazilian community wants to help.");
    await click(tab.page, "Send language request");
    await waitFor(tab.page, () =>
      document.querySelector(".request-list")?.textContent?.includes("Portuguese (Brazil)"),
    );
    assertStringIncludes(await text(tab.page, ".request-list"), "1 vote");
    assertEquals(
      await tab.page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>(".request-list button")].find(
            (b) => b.textContent === "Voted",
          )?.disabled,
      ),
      true,
    );
    await click(tab.page, "Request a language");
    await fill(tab.page, "Search languages", "日本語");
    await tab.page.select("dialog[open] select", "ja");
    await click(tab.page, "Send language request");
    await waitFor(tab.page, () =>
      document.querySelector(".request-list")?.textContent?.includes("Japanese"),
    );
    await signOut(tab.page);
    await signIn(tab.page, server, OWNER);
    await click(tab.page, "Vote for this language", ".request-list li");
    await click(tab.page, "Add my vote", "dialog[open]");
    await waitFor(tab.page, () =>
      document.querySelector(".request-list")?.textContent?.includes("2 votes"),
    );
    await tab.page.goto(`${server.url}/settings`, { waitUntil: "networkidle0" });
    await tab.page.evaluate(() => {
      const section = document.querySelector<HTMLSelectElement>("main select")!;
      section.value = "requests";
      section.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Settings uses a dedicated section so deciding a request never depends on an unrelated form.
    await waitFor(tab.page, () => document.querySelector(".language-requests-admin") !== null);
    await click(tab.page, "Approve language", ".language-requests-admin li");
    await waitFor(
      tab.page,
      () =>
        !document
          .querySelector(".language-requests-admin")
          ?.textContent?.includes("Portuguese (Brazil)"),
    );
    await click(tab.page, "Reject language", ".language-requests-admin li");
    await waitFor(tab.page, () =>
      document
        .querySelector(".language-requests-admin")
        ?.textContent?.includes("No language requests"),
    );
    await tab.page.goto(server.url, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(tab.page, ".language-list"), "Portuguese (Brazil)");
    assertEquals((await server.service.listLanguageRequests(ANONYMOUS, {})).requests, []);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "language requests: default off, saved setting shows and hides the public board",
  { prepare },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, OWNER);
    assertEquals(await tab.page.$(".language-requests"), null);
    await tab.page.goto(`${server.url}/settings?section=requests`, { waitUntil: "networkidle0" });
    await tab.page.click('main input[type="checkbox"]');
    await click(tab.page, "Save");
    await waitFor(
      tab.page,
      () => document.querySelector('[role="status"]')?.textContent === "Saved.",
    );
    await tab.page.goto(server.url, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(tab.page, ".language-requests"), "Requested languages");
    await tab.page.goto(`${server.url}/settings?section=requests`, { waitUntil: "networkidle0" });
    assertEquals(
      await tab.page.$eval(
        'main input[type="checkbox"]',
        (input) => (input as HTMLInputElement).checked,
      ),
      true,
    );
    await tab.page.click('main input[type="checkbox"]');
    await click(tab.page, "Save");
    await waitFor(
      tab.page,
      () => document.querySelector('[role="status"]')?.textContent === "Saved.",
    );
    await tab.page.goto(server.url, { waitUntil: "networkidle0" });
    assertEquals(await tab.page.$(".language-requests"), null);
    assertEquals(tab.problems, []);
  },
);
