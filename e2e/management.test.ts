// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
/** Sprint 8 acceptance: real accounts, real writes and real exports through the browser. */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type { Page } from "puppeteer";
import {
  ANONYMOUS,
  createFakeTranslator,
  type Service,
  SYSTEM,
  backupJsonStream,
  restoreBackup,
  documentSource,
} from "@quaso/service";
import { realService } from "../packages/server/src/testing/real_service.ts";
import type { BackupDocument } from "@quaso/core";
import type { ExportResult, StringsPage } from "@quaso/core";
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
const VOLUNTEER = "volunteer@example.com";

browserTest(
  "provider credentials: restore notice, masked replacement and removal",
  {
    serviceOptions: { providerFactory: () => createFakeTranslator() },
    async prepare(service) {
      const source = await realService();
      try {
        await prepare(source.service);
        await source.service.setSecret(SYSTEM, {
          name: "gemini_api_key",
          value: "original-provider-key-7132",
        });
        const document = (await new Response(
          backupJsonStream(source.service, SYSTEM),
        ).json()) as BackupDocument;
        await restoreBackup(service, documentSource(document));
      } finally {
        source.close();
      }
    },
  },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/signin");
    const { page } = tab;
    await signIn(page, server, OWNER);
    await page.goto(`${server.url}/settings?section=llm`, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(page, "main"), "Enter them again: Gemini API key.");
    assertEquals(
      await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === "Test Gemini key",
          )?.disabled,
      ),
      true,
    );
    const value = "replacement-key-should-never-appear-9876";
    await fill(page, "Gemini API key", value);
    assertEquals(
      await page.$eval('input[type="password"]', (input) => (input as HTMLInputElement).value),
      value,
    );
    await click(page, "Set key");
    await waitFor(page, () =>
      document.querySelector("main")?.textContent?.includes("Set, ending in …9876."),
    );
    assertEquals((await text(page, "main")).includes(value), false);
    assertEquals((await text(page, "main")).includes("Enter them again"), false);
    assertEquals(
      await page.$eval('input[type="password"]', (input) => (input as HTMLInputElement).value),
      "",
    );
    await click(page, "Test Gemini key");
    await waitFor(page, () =>
      document.querySelector("main")?.textContent?.includes("Gemini key works. Available models:"),
    );
    assertStringIncludes(await text(page, "main"), "fake");
    await fill(page, "New Gemini API key", "next-provider-credential-4567");
    await click(page, "Replace");
    await waitFor(page, () =>
      document.querySelector("main")?.textContent?.includes("Set, ending in …4567."),
    );
    assertEquals((await text(page, "main")).includes("Gemini key works"), false);
    await fill(page, "Requests in parallel", "2");
    await fill(page, "Monthly token budget (blank for unlimited)", "100000");
    await click(page, "Save");
    await waitFor(page, () => {
      const section = [...document.querySelectorAll(".management-section")].find(
        (item) => item.querySelector("h2")?.textContent === "LLM translation",
      );
      return section?.querySelector('[role="status"]')?.textContent === "Saved.";
    });
    const settings = await server.service.getSettings(SYSTEM, {});
    assertEquals(settings.settings.llm.concurrency, 2);
    assertEquals(settings.settings.llm.monthlyTokenBudget, 100000);
    await click(page, "Remove key");
    await waitFor(page, () => document.querySelector("dialog[open]") !== null);
    await click(page, "Remove key", "dialog[open]");
    await waitFor(page, () => document.querySelector("main")?.textContent?.includes("Not set."));
    assertEquals((await server.service.listSecrets(SYSTEM, {})).missingSecrets, []);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "the editor retranslates a green string and refreshes its inline job progress",
  {
    prepare,
    serviceOptions: { provider: createFakeTranslator() },
  },
  async ({ server, browser }) => {
    await sources(server);
    await server.api("/imports", {
      method: "POST",
      body: JSON.stringify({
        language: "fr",
        as: "green",
        files: [{ path: "common.json", content: '{"play":"Ancien"}' }],
      }),
    });
    const target = (await getStrings(server, "fr")).strings[0];
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/translate/fr?id=${target.id}`, {
      waitUntil: "networkidle0",
    });
    await click(tab.page, "Translate with the LLM");
    await waitFor(tab.page, () => document.querySelector(".job-card") !== null);
    await server.service.alarm();
    await waitFor(
      tab.page,
      () => document.querySelector(".job-card .status")?.textContent === "done",
    );
    await waitFor(tab.page, () => {
      const input = document.querySelector<HTMLTextAreaElement>("[data-translation-input]");
      return input && input.value !== "Ancien";
    });
    const result = (await getStrings(server, "fr")).strings[0];
    assertEquals(result.translation?.colour, "green");
    assert(result.translation?.value !== "Ancien");
    assertEquals(tab.problems, []);
  },
);

async function prepare(service: Service) {
  const { token } = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: token!,
    email: OWNER,
    password: PASSWORD,
    displayName: "Project Owner",
    projectName: "Browser Project",
  });
  await service.updateSettings(SYSTEM, { llm: { autoTranslate: false } });
}

async function prepareContributor(service: Service) {
  await prepare(service);
  await service.addLanguage(SYSTEM, { tag: "fr" });
  const { user } = await service.signUp(ANONYMOUS, {
    email: VOLUNTEER,
    password: PASSWORD,
    displayName: "French Volunteer",
  });
  await service.updateMember(SYSTEM, { id: user.id, role: "contributor", languages: ["fr"] });
}

browserTest(
  "settings sections stay shareable across desktop navigation and the mobile chooser",
  { prepare },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/signin", (page) =>
      page.setViewport({ width: 1440, height: 1000 }),
    );
    await signIn(page, server, OWNER);
    await page.goto(`${server.url}/settings`, { waitUntil: "networkidle0" });
    await page.click('.settings-navigation a[href*="section=languages"]');
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "languages");
    assert(await page.$('.settings-navigation a[aria-current="page"][href*="section=languages"]'));
    await page.click('.settings-navigation a[href*="section=general"]');
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "general");
    await page.evaluate(() => history.back());
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "languages");
    await page.reload({ waitUntil: "networkidle0" });
    assert(await page.$('.settings-navigation a[aria-current="page"][href*="section=languages"]'));
    await page.setViewport({ width: 360, height: 800 });
    await page.select(".settings-mobile-section select", "general");
    await waitFor(page, () => new URLSearchParams(location.search).get("section") === "general");
    await fill(page, "Project name", "Renamed project");
    await click(page, "Save");
    await waitFor(
      page,
      () => document.querySelector('.settings-save [role="status"]')?.textContent === "Saved.",
    );
    assertEquals((await server.service.getSettings(SYSTEM, {})).settings.name, "Renamed project");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assertEquals(problems, []);
  },
);

async function sources(server: TestServer, value = "Play") {
  await server.api("/sources", {
    method: "POST",
    body: JSON.stringify({
      files: [
        { path: "common.json", repoPath: "common.json", content: JSON.stringify({ play: value }) },
      ],
      sourceLanguage: "en",
      languages: ["fr"],
    }),
  });
}

async function fill(page: Page, label: string, value: string) {
  await page.evaluate((name: string) => {
    const label = [...document.querySelectorAll<HTMLLabelElement>("label")].find(
      (l) => l.textContent?.trim() === name,
    );
    const field = label?.htmlFor
      ? document.getElementById(label.htmlFor)
      : label?.querySelector("input, textarea");
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      throw new Error(`No field labelled ${name}`);
    }
    field.focus();
    field.select();
  }, label);
  await page.keyboard.type(value);
}

async function click(page: Page, name: string, scope = "") {
  await page.evaluate(
    (label: string, scope: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
        throw new Error(`No enabled button ${label}`);
      }
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
  await press(page, "Enter");
  await waitFor(page, () => document.querySelector(".user-name") !== null);
}

async function signOut(page: Page) {
  await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/signout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`Signout ${response.status}`);
  });
}

async function suggestion(page: Page, server: TestServer, id: number, value: string) {
  await page.goto(`${server.url}/translate/fr?id=${id}`, { waitUntil: "networkidle0" });
  await waitFor(page, () => document.querySelector("[data-translation-input]") !== null);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>("[data-translation-input]")!;
    input.focus();
    input.select();
  });
  await page.keyboard.type(value);
  await click(page, "Suggest");
  await waitFor(page, () =>
    document.querySelector(".state-badges")?.textContent?.includes("pending"),
  );
}

async function exported(server: TestServer) {
  const result = await server.api<ExportResult>("/export?languages=fr");
  return JSON.parse(result.files[0].content) as { play: string };
}

browserTest(
  "acceptance 4: a volunteer correction is exported only after review and becomes blue",
  {
    prepare: prepareContributor,
  },
  async ({ server, browser }) => {
    await sources(server);
    await server.api("/imports", {
      method: "POST",
      body: JSON.stringify({
        language: "fr",
        as: "green",
        files: [{ path: "common.json", content: '{"play":"Ancien"}' }],
      }),
    });
    const target = (await getStrings(server, "fr")).strings[0];
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, VOLUNTEER);
    await suggestion(tab.page, server, target.id, "Jouer");
    assertEquals((await exported(server)).play, "Ancien");
    await signOut(tab.page);
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/review`, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(tab.page, ".review-diff"), "Jouer");
    await tab.page.click(".review-comment summary");
    await fill(tab.page, "Review comment (optional)", "Merci !");
    await click(tab.page, "Approve");
    await waitFor(tab.page, () =>
      document.querySelector("main")?.textContent?.includes("No suggestions match"),
    );
    assertEquals((await exported(server)).play, "Jouer");
    await tab.page.goto(`${server.url}/translate/fr?id=${target.id}`, {
      waitUntil: "networkidle0",
    });
    await waitFor(tab.page, () => document.querySelector(".state-badges .badge-blue") !== null);
    assertEquals((await getStrings(server, "fr")).strings[0].translation?.colour, "blue");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "acceptance 7: a source upload marks the editor outdated and keeps the old export",
  {
    prepare,
  },
  async ({ server, browser }) => {
    await sources(server);
    await server.api("/imports", {
      method: "POST",
      body: JSON.stringify({
        language: "fr",
        as: "green",
        files: [{ path: "common.json", content: '{"play":"Jouer"}' }],
      }),
    });
    const target = (await getStrings(server, "fr")).strings[0];
    // Anonymous reads are cacheable for 30 seconds; the reload below must see the change.
    const tab = await openTab(browser, server, `/translate/fr?id=${target.id}`, (page) =>
      page.setCacheEnabled(false),
    );
    await sources(server, "Start playing");
    await tab.page.goto(`${server.url}/translate/fr?id=${target.id}`, {
      waitUntil: "networkidle0",
    });
    await waitFor(tab.page, () =>
      document.querySelector(".state-badges")?.textContent?.includes("Outdated"),
    );
    assertStringIncludes(await text(tab.page, "main"), "Jouer");
    assertEquals((await exported(server)).play, "Jouer");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "acceptance 10: signup, volunteering for French, team approval and a pending translation",
  { prepare },
  async ({ server, browser }) => {
    await sources(server);
    const target = (await getStrings(server, "fr")).strings[0];
    const tab = await openTab(browser, server, "/signup");
    await fill(tab.page, "Display name", "New Volunteer");
    await fill(tab.page, "Email address", VOLUNTEER);
    await fill(tab.page, "Password", PASSWORD);
    await click(tab.page, "Create the account");
    await waitFor(
      tab.page,
      () => document.querySelector(".user-name")?.textContent === "New Volunteer",
    );
    await tab.page.evaluate(() =>
      document.querySelector<HTMLButtonElement>(".user-button")!.click(),
    );
    await click(tab.page, "Become a volunteer");
    await waitFor(
      tab.page,
      () => document.querySelector("dialog[open] input[type=checkbox]") !== null,
    );
    await tab.page.evaluate(() =>
      document.querySelector<HTMLInputElement>("dialog[open] input[type=checkbox]")!.click(),
    );
    await fill(tab.page, "Message", "I can help with French.");
    await click(tab.page, "Send volunteer request");
    await waitFor(tab.page, () => document.querySelector("dialog[open]") === null);
    await tab.page.evaluate(() =>
      document.querySelector<HTMLButtonElement>(".user-button")!.click(),
    );
    await waitFor(tab.page, () =>
      document.querySelector(".menu")?.textContent?.includes("Volunteer request pending"),
    );
    await signOut(tab.page);
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/team`, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(tab.page, "main"), "I can help with French.");
    await click(tab.page, "Approve volunteer");
    await waitFor(tab.page, () =>
      document.querySelector("main")?.textContent?.includes("No volunteer requests are waiting"),
    );
    await signOut(tab.page);
    await signIn(tab.page, server, VOLUNTEER);
    await suggestion(tab.page, server, target.id, "Jouer");
    await tab.page.goto(`${server.url}/contributions`, { waitUntil: "networkidle0" });
    assertStringIncludes(await text(tab.page, ".record-list"), "pending");
    assertStringIncludes(await text(tab.page, ".record-list"), "Jouer");
    assertEquals((await getStrings(server, "fr")).strings[0].translation, null);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "auto-translate estimates and creates a real fake-provider job, then the editor is green",
  { prepare, serviceOptions: { provider: createFakeTranslator() } },
  async ({ server, browser }) => {
    await sources(server);
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, OWNER);
    await waitFor(tab.page, () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.trim() === "Auto-translate" && !button.disabled,
      ),
    );
    await click(tab.page, "Auto-translate");
    await waitFor(tab.page, () =>
      document.querySelector(".estimate")?.textContent?.includes("1 strings"),
    );
    await click(tab.page, "Start translation");
    // The dialog closes; the header shows the job until a notification says it finished.
    await waitFor(tab.page, () => document.querySelector(".job-indicator") !== null);
    await server.service.alarm();
    const completedJobs = await server.service.listJobs(SYSTEM, {});
    assertEquals(completedJobs.jobs[0].status, "done");
    await waitFor(tab.page, () =>
      document.body.textContent?.includes("Translation finished: 1 translated, 0 failed"),
    );
    const target = (await getStrings(server, "fr")).strings[0];
    assertEquals(target.translation?.colour, "green");
    await tab.page.goto(`${server.url}/translate/fr?id=${target.id}`, {
      waitUntil: "networkidle0",
    });
    await waitFor(tab.page, () => document.querySelector(".state-badges .badge-green") !== null);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "API key creation shows the secret once and the stored list only its prefix",
  {
    prepare,
  },
  async ({ server, browser }) => {
    await sources(server);
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/settings`, { waitUntil: "networkidle0" });
    await tab.page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>("main select")!;
      select.value = "keys";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(tab.page, () =>
      [...document.querySelectorAll("label")].some((l) => l.textContent?.includes("Key name")),
    );
    await fill(tab.page, "Key name", "Browser download key");
    await click(tab.page, "Create API key");
    await waitFor(tab.page, () =>
      document.querySelector<HTMLTextAreaElement>(".secret-value")?.value.startsWith("qso_"),
    );
    const secret = await tab.page.evaluate(
      () => document.querySelector<HTMLTextAreaElement>(".secret-value")!.value,
    );
    assertMatch(secret, /^qso_/);
    await click(tab.page, "Done", "dialog[open]");
    assertEquals(
      await tab.page.evaluate(
        (s: string) =>
          document.body.textContent?.includes(s) ||
          [
            ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
          ].some((input) => input.value === s),
        secret,
      ),
      false,
    );
    const response = await fetch(`${server.url}/api/v1/strings?language=fr`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert(response.ok);
    (await response.json()) as StringsPage;
    await tab.page.goto(`${server.url}/settings`, { waitUntil: "networkidle0" });
    assertEquals(
      await tab.page.evaluate(() => document.querySelector(".secret-value") !== null),
      false,
    );
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "saved settings, file context and length limits survive switching sections",
  {
    prepare,
  },
  async ({ server, browser }) => {
    await sources(server);
    const tab = await openTab(browser, server, "/signin");
    const { page } = tab;
    await signIn(page, server, OWNER);
    await page.goto(`${server.url}/settings`, { waitUntil: "networkidle0" });
    const section = async (value: string) => {
      await page.evaluate((value: string) => {
        const select = document.querySelector<HTMLSelectElement>("main select")!;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
    };
    const save = async (title: string) => {
      await page.evaluate((title: string) => {
        const section = [...document.querySelectorAll(".management-section")].find(
          (s) => s.querySelector("h2")?.textContent === title,
        );
        section!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      }, title);
      await waitFor(
        page,
        (title: string) => {
          const section = [...document.querySelectorAll(".management-section")].find(
            (s) => s.querySelector("h2")?.textContent === title,
          );
          return [...(section?.querySelectorAll('[role="status"]') ?? [])].some(
            (status) => status.textContent === "Saved.",
          );
        },
        [title],
      );
    };
    const value = (label: string) =>
      page.evaluate((label: string) => {
        const field = [...document.querySelectorAll("label")].find(
          (l) => l.querySelector(".field-label")?.textContent === label,
        );
        return field?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
          ?.value;
      }, label);

    await fill(page, "Project name", "Saved project name");
    await save("General");
    await section("retention");
    await fill(page, "File history days", "0");
    await fill(page, "Backup retention days", "7");
    await save("Retention");
    await section("llm");
    await fill(page, "Project instructions", "Use a friendly voice.");
    await save("LLM translation");
    await section("general");
    assertEquals(await value("Project name"), "Saved project name");
    await section("retention");
    assertEquals(await value("File history days"), "0");
    assertEquals(await value("Backup retention days"), "7");
    await section("llm");
    assertEquals(await value("Project instructions"), "Use a friendly voice.");
    await section("files");
    await fill(page, "File context", "Buttons in the main menu.");
    await save("common.json");
    await waitFor(page, () => document.querySelector('input[type="number"]') !== null);
    await fill(page, "Maximum characters (empty means no limit)", "12");
    await save("common.json: play");
    await section("general");
    await section("files");
    assertEquals(await value("File context"), "Buttons in the main menu.");
    assertEquals(await value("Maximum characters (empty means no limit)"), "12");
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "management pages fit 320 px and the auto-translate dialog returns keyboard focus",
  {
    prepare,
    serviceOptions: { provider: createFakeTranslator() },
  },
  async ({ server, browser }) => {
    await sources(server);
    const tab = await openTab(browser, server, "/signin", (page) =>
      page.setViewport({ width: 320, height: 760 }),
    );
    await signIn(tab.page, server, OWNER);
    for (const path of [
      "/review",
      "/contributions",
      "/team",
      "/settings",
      "/jobs",
      "/usage",
      "/account",
      "/admin",
    ]) {
      await tab.page.goto(`${server.url}${path}`, { waitUntil: "networkidle0" });
      const overflow = await tab.page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert(
        overflow.width <= overflow.viewport + 1,
        `${path} overflows: ${JSON.stringify(overflow)}`,
      );
      assert(!(await text(tab.page, "main")).includes("Something went wrong"), path);
    }
    await tab.page.goto(`${server.url}/`, { waitUntil: "networkidle0" });
    await tab.page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Auto-translate")!
        .focus(),
    );
    await press(tab.page, "Enter");
    await waitFor(tab.page, () => document.querySelector("dialog[open]") !== null);
    await press(tab.page, "Escape");
    await waitFor(tab.page, () => document.querySelector("dialog[open]") === null);
    assertEquals(
      await tab.page.evaluate(() => document.activeElement?.textContent?.trim()),
      "Auto-translate",
    );
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "bulk review reports QA failures per item while approving valid proposals",
  { prepare },
  async ({ server, browser }) => {
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [
          {
            path: "common.json",
            repoPath: "common.json",
            content: '{"play":"Play","quit":"Quit"}',
          },
        ],
        languages: ["fr"],
      }),
    });
    const strings = (await getStrings(server, "fr")).strings;
    for (const string of strings) {
      await server.service.suggest(SYSTEM, {
        id: string.id,
        language: "fr",
        kind: "translation",
        value: string.key === "play" ? "Jouer" : "Quitter",
        baseRevision: 0,
      });
    }
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [
          {
            path: "common.json",
            repoPath: "common.json",
            content: '{"play":"Play","quit":"Quit {{game}}"}',
          },
        ],
        languages: ["fr"],
      }),
    });
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/review`, { waitUntil: "networkidle0" });
    await tab.page.evaluate(() =>
      document
        .querySelector<HTMLInputElement>("main .management-section input[type=checkbox]")!
        .click(),
    );
    await click(tab.page, "Approve selected (2)");
    await waitFor(tab.page, () =>
      document.querySelector("main [role=alert]")?.textContent?.includes("qa_failed"),
    );
    assertStringIncludes(await text(tab.page, "main [role=alert]"), "game");
    const result = await getStrings(server, "fr");
    assertEquals(result.strings.find((s) => s.key === "play")?.translation?.colour, "blue");
    assertEquals(result.strings.find((s) => s.key === "quit")?.translation, null);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "upload rename suggestions can be applied from Activity and appear in editor history",
  {
    prepare,
  },
  async ({ server, browser }) => {
    await sources(server);
    await server.api("/imports", {
      method: "POST",
      body: JSON.stringify({
        language: "fr",
        as: "green",
        files: [{ path: "common.json", content: '{"play":"Jouer"}' }],
      }),
    });
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "common.json", repoPath: "common.json", content: '{"start":"Play"}' }],
        languages: ["fr"],
      }),
    });
    const tab = await openTab(browser, server, "/signin");
    await signIn(tab.page, server, OWNER);
    await tab.page.goto(`${server.url}/activity`, { waitUntil: "networkidle0" });
    await click(tab.page, "Apply rename");
    await waitFor(tab.page, () => document.querySelector("dialog[open]") !== null);
    assertStringIncludes(await text(tab.page, "dialog[open]"), "Translations and history");
    await click(tab.page, "Apply rename", "dialog[open]");
    await waitFor(tab.page, () =>
      document.querySelector("main")?.textContent?.includes("Rename applied."),
    );
    const target = (await getStrings(server, "fr")).strings[0];
    assertEquals([target.key, target.translation?.value], ["start", "Jouer"]);
    await tab.page.goto(`${server.url}/translate/fr?id=${target.id}`, {
      waitUntil: "networkidle0",
    });
    await click(tab.page, "History");
    await waitFor(tab.page, () =>
      document.querySelector(".history")?.textContent?.includes("Renamed from play"),
    );
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "email settings save, send a test and hide stale success after editing",
  {
    serviceOptions: { emailFetch: async () => Response.json({ id: "test-message" }) },
    async prepare(service) {
      await prepare(service);
      await service.setSecret(SYSTEM, { name: "email_api_key", value: "test-email-key-1234" });
    },
  },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/signin");
    const { page } = tab;
    await signIn(page, server, OWNER);
    await page.goto(`${server.url}/settings?section=email`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const section = [...document.querySelectorAll(".management-section")].find(
        (section) => section.querySelector("h2")?.textContent === "Email delivery",
      )!;
      const select = section.querySelector("select")!;
      select.value = "resend";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await fill(page, "Sender address", "Quaso <quaso@example.com>");
    await page.evaluate(() => {
      const section = [...document.querySelectorAll(".management-section")].find(
        (section) => section.querySelector("h2")?.textContent === "Email delivery",
      )!;
      section.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await waitFor(page, () => document.querySelector("main")!.textContent!.includes("Saved."));
    await fill(page, "Test recipient", "reader@example.com");
    await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Send test email")!
        .click(),
    );
    await waitFor(page, () =>
      document.querySelector("main")!.textContent!.includes("Test message accepted."),
    );
    assertEquals((await server.service.getSettings(SYSTEM, {})).settings.email, {
      provider: "resend",
      from: "Quaso <quaso@example.com>",
      accountId: "",
    });
    await fill(page, "Sender address", "other@example.com");
    assertEquals((await text(page, "main")).includes("Test message accepted."), false);
    await page.reload({ waitUntil: "networkidle0" });
    assertEquals(
      await page.evaluate(() =>
        [...document.querySelectorAll("input")].some(
          (input) => input.value === "Quaso <quaso@example.com>",
        ),
      ),
      true,
    );
    assertEquals(tab.problems, []);
  },
);
