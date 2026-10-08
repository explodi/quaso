// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
import { assertEquals, assertStringIncludes } from "@std/assert";
import { ANONYMOUS, SYSTEM, type Service } from "@quaso/service";
import { browserTest, openTab, press, text, waitFor } from "./_setup.ts";

const EMAIL = "queue@example.com";
const PASSWORD = "a long queue test password";
async function prepare(service: Service) {
  const setup = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: setup.token!,
    email: EMAIL,
    password: PASSWORD,
    displayName: "Queue Owner",
    projectName: "Queue test",
  });
}

browserTest(
  "translation queue stays fixed after saves, recomputes on reload and reaches Done",
  { prepare },
  async ({ server, browser }) => {
    const keys = Array.from({ length: 23 }, (_, index) => `k${String(index + 1).padStart(2, "0")}`);
    await server.api("/sources", {
      method: "POST",
      body: JSON.stringify({
        files: [
          {
            path: "queue.json",
            repoPath: "queue.json",
            content: JSON.stringify(Object.fromEntries(keys.map((key) => [key, key]))),
          },
        ],
        sourceLanguage: "en",
        languages: ["de"],
      }),
    });
    const { page, problems } = await openTab(browser, server, "/signin", (page) =>
      page.setViewport({ width: 1440, height: 1000 }),
    );
    await page.evaluate(
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
    await page.goto(`${server.url}/translate/de`, { waitUntil: "networkidle0" });
    const panel = (key: string) =>
      waitFor(
        page,
        (expected: string) => document.querySelector(".panel-key code")?.textContent === expected,
        [key],
      );
    const save = async (key: string) => {
      await panel(key);
      await page.focus(".pane-panel textarea");
      await page.keyboard.type(`Deutsch ${key}`);
      await waitFor(
        page,
        (expected: string) =>
          document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")?.value ===
            `Deutsch ${expected}` &&
          document.querySelector<HTMLButtonElement>(".panel-actions .btn-primary")?.disabled ===
            false,
        [key],
      );
      await press(page, "Enter", ["Control"]);
    };
    await panel("k01");
    assertEquals(await text(page, ".queue-navigation [role=status]"), "1 / 23");
    await save("k01");
    await save("k02");
    await save("k03");
    await panel("k04");
    assertEquals(await text(page, ".queue-navigation [role=status]"), "4 / 23");
    assertStringIncludes(await text(page, '[data-index="0"] .row-key'), "k01");
    await press(page, "ArrowUp", ["Alt", "Shift"]);
    await panel("k04");
    await press(page, "ArrowDown", ["Alt", "Shift"]);
    await panel("k05");
    await press(page, "ArrowUp", ["Alt", "Shift"]);
    await panel("k04");

    await page.reload({ waitUntil: "networkidle0" });
    await panel("k04");
    await waitFor(page, () =>
      document.querySelector('[data-index="0"] .row-key')?.textContent?.includes("k04"),
    );
    assertEquals(await text(page, ".queue-navigation [role=status]"), "1 / 20");
    for (const key of keys.slice(3)) await save(key);
    await waitFor(
      page,
      () => document.querySelector(".queue-navigation [role=status]")?.textContent === "Done",
    );

    await page.select(".strings-order select", "file");
    await waitFor(page, () => new URLSearchParams(location.search).get("order") === "file");
    await page.click(".pane-files [data-path='queue.json'] .tree-name");
    await waitFor(page, () => new URLSearchParams(location.search).get("file") === "queue.json");
    assertEquals(
      await page.evaluate(() => new URLSearchParams(location.search).get("order")),
      "file",
    );
    await page.click(".editor-bar-end button:last-child");
    await waitFor(page, () =>
      document.querySelector("dialog[open]")?.textContent?.includes("Next string to do"),
    );
    assertStringIncludes(await text(page, "dialog[open]"), "Previous string to do");
    assertEquals(problems, []);
  },
);

browserTest(
  "next to do crosses a page of removed strings without changing the opening queue",
  {},
  async ({ server, browser }) => {
    const keys = Array.from(
      { length: 401 },
      (_, index) => `k${String(index + 1).padStart(3, "0")}`,
    );
    const upload = (wanted: string[]) =>
      server.api("/sources", {
        method: "POST",
        body: JSON.stringify({
          files: [
            {
              path: "many.json",
              repoPath: "many.json",
              content: JSON.stringify(Object.fromEntries(wanted.map((key) => [key, key]))),
            },
          ],
          sourceLanguage: "en",
          languages: ["de"],
        }),
      });
    await upload(keys);
    const opening = await server.api<{ ids: number[]; toDo: number }>("/strings/queue?language=de");
    const { page, problems } = await openTab(browser, server, `/translate/de?id=${opening.ids[0]}`);
    await waitFor(
      page,
      () => document.querySelector(".queue-navigation [role=status]")?.textContent === "1 / 401",
    );
    await upload([...keys.slice(0, 200), keys[400]]);
    await page.evaluate((id) => {
      const url = new URL(location.href);
      url.searchParams.set("id", String(id));
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, opening.ids[199]);
    await waitFor(page, () => document.querySelector(".panel-key code")?.textContent === "k200");
    await press(page, "ArrowDown", ["Alt", "Shift"]);
    await waitFor(page, () => document.querySelector(".panel-key code")?.textContent === "k401");
    assertEquals(await text(page, ".queue-navigation [role=status]"), "401 / 401");
    await press(page, "ArrowUp", ["Alt", "Shift"]);
    await waitFor(page, () => document.querySelector(".panel-key code")?.textContent === "k200");
    assertEquals(problems, []);
  },
);
