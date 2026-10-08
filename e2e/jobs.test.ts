// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { ANONYMOUS, createFakeTranslator, SYSTEM, type Service } from "@quaso/service";
import { browserTest, openTab, waitFor } from "./_setup.ts";

const EMAIL = "jobs@example.com";
const PASSWORD = "a long test password";

async function prepare(service: Service) {
  const setup = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: setup.token!,
    email: EMAIL,
    password: PASSWORD,
    displayName: "Job Owner",
    projectName: "Job test",
  });
  await service.updateSettings(SYSTEM, {
    llm: { autoTranslate: false, context: { fileContext: false } },
  });
  await service.upload(SYSTEM, {
    sourceLanguage: "en",
    languages: ["fr"],
    files: [
      { path: "one.json", repoPath: "one.json", content: '{"one":"First"}' },
      { path: "two.json", repoPath: "two.json", content: '{"two":"Second"}' },
    ],
  });
}

const fake = createFakeTranslator();
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let calls = 0;
let activeRequests = 0;
const provider = {
  ...fake,
  async translate(request: Parameters<typeof fake.translate>[0]) {
    calls++;
    if (calls === 2) await gate;
    return fake.translate(request);
  },
};

browserTest(
  "job progress persists from dashboard to editor and refreshes completed counts",
  {
    prepare,
    serviceOptions: { provider, llmConcurrency: 1 },
    intercept(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/jobs" && url.searchParams.get("active") === "true")
        activeRequests++;
      return undefined;
    },
  },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, "/signin");
    await tab.page.evaluate(
      async (email, password) => {
        const response = await fetch("/api/v1/auth/signin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!response.ok) throw new Error(`Sign-in ${response.status}`);
      },
      EMAIL,
      PASSWORD,
    );
    await tab.page.goto(server.url, { waitUntil: "networkidle0" });
    await tab.page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === "Auto-translate",
      );
      button!.click();
    });
    await waitFor(tab.page, () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.trim() === "Start translation" && !button.disabled,
      ),
    );
    await tab.page.evaluate(() => {
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Start translation")!
        .click();
    });
    await waitFor(tab.page, () =>
      document.querySelector(".job-indicator")?.textContent?.includes("0%"),
    );
    await waitFor(tab.page, () => document.querySelector("dialog[open]") === null);
    await tab.page.click('a.language-link[href="/languages/fr"]');
    await waitFor(tab.page, () => document.querySelector('a[href="/translate/fr"]') !== null);
    await tab.page.click('a[href="/translate/fr"]');
    await waitFor(tab.page, () => location.pathname === "/translate/fr");
    const running = server.service.alarm();
    try {
      await waitFor(tab.page, () =>
        document.querySelector(".job-indicator")?.textContent?.includes("50%"),
      );
      assertEquals(
        await tab.page.$eval(".job-indicator progress", (element) =>
          element.getAttribute("aria-valuetext"),
        ),
        "50 percent, 1 of 2 strings",
      );
      await tab.page.reload({ waitUntil: "networkidle0" });
      await waitFor(tab.page, () =>
        document.querySelector(".job-indicator")?.textContent?.includes("50%"),
      );
      const before = activeRequests;
      await tab.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await new Promise((resolve) => setTimeout(resolve, 2400));
      assertEquals(activeRequests, before, "hidden tabs do not poll active jobs");
      await tab.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } finally {
      release();
    }
    await running;
    await waitFor(tab.page, () =>
      document
        .querySelector(".toasts")
        ?.textContent?.includes("Translation finished: 2 translated, 0 failed"),
    );
    await waitFor(tab.page, () => document.querySelector(".job-indicator") === null);
    await tab.page.click('a.brand[href="/"]');
    await waitFor(tab.page, () =>
      document.querySelector(".language-row")?.textContent?.includes("100% translated"),
    );
    assertEquals(
      await tab.page.$eval(".toasts", (element) => element.getAttribute("aria-live")),
      "polite",
    );
    await tab.page.click('.toast a[href^="/jobs#job-"]');
    await waitFor(tab.page, () =>
      document.querySelector(".job-card .job-progress-label")?.textContent?.includes("100%"),
    );
    await tab.page.click('.toast button[aria-label="Dismiss"]');
    await waitFor(
      tab.page,
      () => !document.querySelector(".toasts")?.textContent?.includes("Translation finished"),
    );
    assertEquals(tab.problems, []);
  },
);
