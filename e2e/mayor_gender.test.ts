// SPDX-License-Identifier: MIT
import { expect } from "vitest";
import type { Page } from "puppeteer";
import { ANONYMOUS, type Service, SYSTEM } from "@quaso/service";
import { browserTest, getStrings, openTab, press, text, waitFor } from "./_setup.ts";

const EMAIL = "mayor-editor@example.com";
const PASSWORD = "mayor editor browser test password";
const SPANISH =
  "{mayorGender, select, female {La alcaldesa {name}} male {El alcalde {name}} other {La persona en la alcaldía, {name}}}";

async function prepare(service: Service) {
  const { token } = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: token!,
    email: EMAIL,
    password: PASSWORD,
    displayName: "Newspaper Editor",
    projectName: "Mayor pronouns",
  });
  await service.updateSettings(SYSTEM, {
    syntax: { prefix: "{{", suffix: "}}", icu: true },
    llm: { autoTranslate: false },
  });
  await service.upload(SYSTEM, {
    sourceLanguage: "en",
    languages: ["es"],
    arguments: [
      {
        name: "mayorGender",
        cases: ["female", "male"],
        description:
          "The mayor's chosen pronouns: female is she/her, male is he/him, other is they/them. Rephrase other without assigning a gender.",
      },
    ],
    files: [
      {
        path: "newspaper.json",
        repoPath: "src/locales/en/newspaper.json",
        content: '{"headline":"Mayor {name}"}',
      },
    ],
  });
}

async function fillTranslation(page: Page, value: string) {
  await page.$eval("#translation-text", (field) => {
    const input = field as HTMLTextAreaElement;
    input.focus();
    input.select();
  });
  await page.keyboard.type(value);
}

browserTest(
  "a translator adds mayor pronouns, previews and saves all cases, and keeps an invalid draft",
  { prepare },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/signin", (page) =>
      page.setViewport({ width: 1600, height: 1000 }),
    );
    await page.type("::-p-aria(Email address)", EMAIL);
    await page.type("::-p-aria(Password)", PASSWORD);
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector(".user-name") !== null);
    const headline = (await getStrings(server, "es")).strings[0];
    await page.goto(`${server.url}/translate/es?id=${headline.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#translation-text");
    expect(await text(page, ".panel-arguments")).toContain(
      "Can vary by mayorGender (female, male, other)",
    );

    await fillTranslation(page, "Alcaldía {name}");
    await page.$eval("#translation-text", (field) => (field as HTMLTextAreaElement).select());
    await page.locator("::-p-aria(Vary by mayorGender)").click();
    expect(
      await page.$eval("#translation-text", (field) => (field as HTMLTextAreaElement).value),
    ).toBe(
      "{mayorGender, select, female {Alcaldía {name}} male {Alcaldía {name}} other {Alcaldía {name}}}",
    );

    await fillTranslation(page, SPANISH);
    await waitFor(page, () => document.querySelectorAll(".icu-preview-row").length === 3);
    await waitFor(
      page,
      () => document.querySelector(".icu-preview-text")?.textContent === "La alcaldesa {name}",
    );
    expect(
      await page.$$eval(".icu-preview-row", (rows) =>
        rows.map((row) => [
          row.querySelector(".form-name")?.textContent,
          row.querySelector(".icu-preview-text")?.textContent,
        ]),
      ),
    ).toStrictEqual([
      ["female", "La alcaldesa {name}"],
      ["male", "El alcalde {name}"],
      ["other", "La persona en la alcaldía, {name}"],
    ]);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/strings/${headline.id}/translations/es`),
    );
    await page.locator(".panel-actions button ::-p-text(Save)").click();
    expect((await saved).ok()).toBe(true);
    // The success toast follows the background refresh, when reloading is safe.
    await waitFor(
      page,
      () =>
        document.querySelector(".toast-message")?.textContent ===
        "Saved newspaper.json › headline: proofread (blue) now.",
    );
    expect((await getStrings(server, "es")).strings[0].translation?.value).toBe(SPANISH);

    await page.goto(`${server.url}/translate/es?id=${headline.id}`, {
      waitUntil: "domcontentloaded",
    });
    await waitFor(
      page,
      (savedText) =>
        document.querySelector<HTMLTextAreaElement>("#translation-text")?.value === savedText,
      [SPANISH],
    );
    const broken = SPANISH.slice(0, -1);
    await fillTranslation(page, broken);
    await waitFor(page, () =>
      document
        .querySelector("#translation-text-checks")
        ?.textContent?.includes("This { is never closed."),
    );
    expect(await text(page, "#save-blocked")).toBe("Saving waits until the errors are fixed.");
    expect(
      await page.$eval(".panel-actions button", (button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    await press(page, "Enter", ["Control"]);
    expect(
      await page.$eval("#translation-text", (field) => (field as HTMLTextAreaElement).value),
    ).toBe(broken);
    expect((await getStrings(server, "es")).strings[0].translation?.value).toBe(SPANISH);
    expect(problems).toStrictEqual([]);
  },
);
