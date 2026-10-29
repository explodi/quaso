// SPDX-License-Identifier: MIT
import { assert, expect } from "vitest";

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
    expect(await text(page, ".account-keys")).toContain(
      "Your role doesn't allow downloading, uploading or translating with the CLI yet.",
    );
    expect((await text(page, ".account-keys")).includes("Browser tests")).toBe(false);

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
    expect(secret).toMatch(/^qso_/);
    const key = (await server.service.listApiTokens(SYSTEM, {})).tokens.find(
      (token) => token.name === "My laptop",
    );
    assert(key);
    expect(key.scope).toBe("read");
    await waitFor(
      page,
      () => document.querySelector(".account-keys .record-card h3")?.textContent === "My laptop",
    );
    expect(await text(page, ".account-keys .record-card")).toContain(key.prefix);
    expect((await text(page, ".account-keys .record-card")).includes(secret)).toBe(false);

    const authorized = await fetch(`${server.url}/api/v1/project`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(authorized.status).toBe(200);
    await authorized.arrayBuffer();
    await page.click("dialog[open] .dialog-footer button");
    await waitFor(page, () => document.querySelector("dialog[open]") === null);
    expect(
      await page.evaluate(
        (value: string) =>
          document.body.textContent?.includes(value) ||
          [
            ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
          ].some((input) => input.value === value),
        secret,
      ),
    ).toBe(false);

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
    expect(revoked.status).toBe(401);
    await revoked.arrayBuffer();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    expect(problems).toStrictEqual([]);
  },
);
