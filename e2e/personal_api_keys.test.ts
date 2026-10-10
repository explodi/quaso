// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { ANONYMOUS, SYSTEM, type Service } from "@quaso/service";
import { browserTest, openTab, press, text, waitFor } from "./_setup.ts";

const EMAIL = "contributor-keys@example.com";
const PASSWORD = "a personal API key test password";

async function prepare(service: Service) {
  const setup = await service.ensureSetupToken(SYSTEM, {});
  await service.completeSetup(ANONYMOUS, {
    token: setup.token!,
    email: "owner-keys@example.com",
    password: PASSWORD,
    displayName: "Project Owner",
    projectName: "Personal keys",
  });
  const { user } = await service.signUp(ANONYMOUS, {
    email: EMAIL,
    password: PASSWORD,
    displayName: "Contributor",
  });
  await service.updateMember(SYSTEM, { id: user.id, role: "contributor", languages: null });
}

browserTest(
  "a contributor creates and revokes a personal read key from Account without revealing it twice",
  { prepare },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/signin");
    await page.type('.auth-card input[type="email"]', EMAIL);
    await page.type('.auth-card input[type="password"]', PASSWORD);
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector(".user-name")?.textContent === "Contributor");
    await page.goto(`${server.url}/account`, { waitUntil: "networkidle0" });
    await waitFor(page, () =>
      document.querySelector(".account-keys")?.textContent?.includes("You have no API keys yet."),
    );
    assertStringIncludes(
      await text(page, ".account-keys"),
      "Your role doesn't allow downloading, uploading or translating with the CLI yet.",
    );
    assertEquals((await text(page, ".account-keys")).includes("Browser tests"), false);

    await page.type(".account-keys input", "My laptop");
    await page.select(".account-keys select", "read");
    await page.click('.account-keys button[type="submit"]');
    await waitFor(page, () =>
      document
        .querySelector<HTMLTextAreaElement>("dialog[open] .secret-value")
        ?.value.startsWith("qso_"),
    );
    const secret = await page.$eval(
      "dialog[open] .secret-value",
      (input) => (input as HTMLTextAreaElement).value,
    );
    assertMatch(secret, /^qso_/);
    const key = (await server.service.listApiTokens(SYSTEM, {})).tokens.find(
      (token) => token.name === "My laptop",
    );
    assert(key);
    assertEquals(key.scope, "read");
    await waitFor(
      page,
      () => document.querySelector(".account-keys .record-card h3")?.textContent === "My laptop",
    );
    assertStringIncludes(await text(page, ".account-keys .record-card"), key.prefix);
    assertEquals((await text(page, ".account-keys .record-card")).includes(secret), false);

    const authorized = await fetch(`${server.url}/api/v1/project`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assertEquals(authorized.status, 200);
    await authorized.arrayBuffer();
    await page.click("dialog[open] .dialog-footer button");
    await waitFor(page, () => document.querySelector("dialog[open]") === null);
    assertEquals(
      await page.evaluate(
        (value: string) =>
          document.body.textContent?.includes(value) ||
          [
            ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
          ].some((input) => input.value === value),
        secret,
      ),
      false,
    );

    await page.setViewport({ width: 320, height: 760 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.click(".account-keys .record-card button");
    await waitFor(page, () => document.querySelector("dialog[open]") !== null);
    await page.click("dialog[open] .dialog-footer .btn-danger");
    await waitFor(page, () =>
      document.querySelector(".account-keys .record-card")?.textContent?.includes("Revoked"),
    );
    const revoked = await fetch(`${server.url}/api/v1/project`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assertEquals(revoked.status, 401);
    await revoked.arrayBuffer();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assertEquals(problems, []);
  },
);
