// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
/**
 * Signing in and out in a browser: where the website goes after signing in (never to
 * another site, however `next` is spelled), and what it does when the session ends while
 * someone is working (a 401).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { SessionInfo } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "@quaso/service";
import {
  apiError,
  browserTest,
  getStrings,
  MANAGER_SESSION,
  openTab,
  press,
  SIGNED_OUT_SESSION,
  text,
  waitFor,
} from "./_setup.ts";

/** `next` values that the URL parser turns into another site's address. */
const HOSTILE = [
  "/%09/evil.example/pwned",
  "/%0A/evil.example/pwned",
  "/%0D/evil.example/pwned",
  "/.//evil.example/pwned",
  "/%5C/evil.example/pwned",
];

browserTest(
  "an unverified email sign-in link explains recovery and the password reset works",
  {
    async prepare(service) {
      // Email is configured in Settings → Email, as an administrator would.
      await service.updateSettings(SYSTEM, {
        email: { provider: "resend", from: "Quaso <quaso@example.com>", accountId: "" },
      });
      await service.setSecret(SYSTEM, { name: "email_api_key", value: "unused-browser-test-key" });
      const setup = await service.ensureSetupToken(SYSTEM, {});
      await service.completeSetup(ANONYMOUS, {
        token: setup.token!,
        email: "owner@example.com",
        password: "correct horse battery",
        displayName: "Project Owner",
        projectName: "Recovery test",
      });
      await service.signUp(ANONYMOUS, {
        email: "recovery@example.com",
        password: "previous password",
        displayName: "Recovery User",
      });
    },
  },
  async ({ server, browser }) => {
    const link = await server.service.createEmailToken(SYSTEM, {
      email: "recovery@example.com",
      purpose: "signin",
    });
    assert(link);
    const tab = await openTab(browser, server, `/signin/link?token=${link.token}`);
    const { page } = tab;
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("main button")!.click());
    await waitFor(page, () => document.querySelector('[role="alert"] a') !== null);
    assertStringIncludes(await text(page, '[role="alert"]'), "email address is unverified");
    assertStringIncludes(await text(page, '[role="alert"]'), "Request a password reset");
    assertEquals(
      await page.evaluate(() => document.querySelector('[role="alert"] a')!.getAttribute("href")),
      "/forgot-password",
    );
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('[role="alert"] a')!.click(),
    );
    await waitFor(page, () => location.pathname === "/forgot-password");
    await waitFor(page, () => document.querySelector('main input[type="email"]') !== null);
    assertStringIncludes(
      await text(page, "main"),
      "We'll send you a link to choose a new password.",
    );
    // Issue the reset link directly: no mail provider is contacted by the browser test.
    const reset = await server.service.createEmailToken(SYSTEM, {
      email: "recovery@example.com",
      purpose: "reset",
    });
    assert(reset);
    await page.goto(`${server.url}/reset-password?token=${reset.token}`, {
      waitUntil: "networkidle0",
    });
    const password = "a recovered password";
    for (const index of [0, 1]) {
      await page.evaluate((i: number) => {
        document.querySelectorAll<HTMLInputElement>('input[type="password"]')[i].focus();
      }, index);
      await page.keyboard.type(password);
    }
    await press(page, "Enter");
    await waitFor(page, () =>
      document.querySelector("main")?.textContent?.includes("Password changed"),
    );
    await waitFor(
      page,
      () => document.querySelector(".user-name")?.textContent === "Recovery User",
    );
    const signedIn = await server.service.signIn(ANONYMOUS, {
      email: "recovery@example.com",
      password,
    });
    assertEquals(signedIn.user.emailVerified, true);
    assertEquals(
      tab.problems.filter((p) => !/status of 403 .*\/auth\/email-link\)$/.test(p)),
      [],
    );
  },
);

browserTest(
  "after signing in, `next` never leads to another site",
  { seed: true, session: MANAGER_SESSION },
  async ({ server, browser }) => {
    // Signed in already: /signin offers "Continue" to `next`.
    for (const next of HOSTILE) {
      const tab = await openTab(browser, server, `/signin?next=${next}`);
      const { page } = tab;
      await waitFor(page, () => document.querySelector("main a")?.textContent === "Continue");
      const target = await page.evaluate(
        () => document.querySelector<HTMLAnchorElement>("main a")!.href,
      );
      assertEquals(target, `${server.url}/`, next);
      await page.evaluate(() => document.querySelector<HTMLAnchorElement>("main a")!.click());
      await waitFor(
        page,
        () => location.pathname === "/" && document.querySelector("main h1") !== null,
      );
      assertEquals(await page.evaluate(() => location.origin), server.url, next);
      assertEquals(tab.problems, [], next);
      await page.close();
    }
  },
);

browserTest(
  "signing in with the form goes to `next` on this site only, and so do the provider links",
  {
    seed: true,
    intercept: (() => {
      let session: SessionInfo = SIGNED_OUT_SESSION;
      return async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/auth/session") {
          return Response.json(session, { headers: { "Cache-Control": "no-store" } });
        }
        // The session is faked, so the header's job poll can't reach the real server.
        if (path === "/api/v1/jobs") {
          return Response.json({ jobs: [] }, { headers: { "Cache-Control": "no-store" } });
        }
        if (path === "/api/v1/auth/signin" && request.method === "POST") {
          const body = await request.json();
          assertEquals(body.email, "mia@example.com");
          session = MANAGER_SESSION;
          return Response.json({}, { headers: { "Cache-Control": "no-store" } });
        }
        return undefined;
      };
    })(),
  },
  async ({ server, browser }) => {
    const tab = await openTab(browser, server, `/signin?next=${HOSTILE[0]}`);
    const { page } = tab;
    await waitFor(page, () => document.querySelector('input[type="password"]') !== null);
    // The GitHub link passes a harmless `next` to the server.
    assertEquals(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>("a")]
          .find((a) => a.textContent?.includes("GitHub"))
          ?.getAttribute("href"),
      ),
      "/auth/github?next=%2F",
    );
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('input[type="email"]')!.focus(),
    );
    await page.keyboard.type("mia@example.com");
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('input[type="password"]')!.focus(),
    );
    await page.keyboard.type("correct horse battery");
    await press(page, "Enter");
    await waitFor(page, () => document.querySelector(".user-name")?.textContent === "Mia Manager");
    await waitFor(page, () => location.pathname === "/");
    assertEquals(await page.evaluate(() => location.origin), server.url);
    assertEquals(tab.problems, []);
  },
);

browserTest(
  "a 401 while working: the session is fetched again, and the error offers to sign in",
  {
    seed: true,
    intercept: (() => {
      let signedIn = true;
      let sessions = 0;
      let saves = 0;
      return (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/auth/session") {
          sessions++;
          return Response.json(signedIn ? MANAGER_SESSION : SIGNED_OUT_SESSION, {
            headers: { "Cache-Control": "no-store", "X-Sessions": String(sessions) },
          });
        }
        // The session is faked, so the header's job poll can't reach the real server.
        if (url.pathname === "/api/v1/jobs") {
          return Response.json({ jobs: [] }, { headers: { "Cache-Control": "no-store" } });
        }
        if (url.pathname === "/test/sessions") return Response.json({ sessions, saves });
        if (url.pathname === "/test/sign-out") {
          signedIn = false;
          return Response.json({});
        }
        if (request.method === "PUT" && url.pathname.includes("/translations/")) {
          saves++;
          return apiError(401, "unauthorized", "Sign in first.");
        }
        return undefined;
      };
    })(),
  },
  async ({ server, browser }) => {
    const { strings } = await getStrings(server, "fr", "&state=untranslated");
    const target = strings[0];
    const tab = await openTab(browser, server, `/translate/fr?id=${target.id}`);
    const { page } = tab;
    const counts = async () =>
      JSON.parse(await page.evaluate(() => fetch("/test/sessions").then((r) => r.text()))) as {
        sessions: number;
        saves: number;
      };
    await waitFor(page, () => document.querySelector(".pane-panel textarea") !== null);
    const before = await counts();

    // The server still says signed in (a cookie problem, say): the error offers to sign in,
    // coming back here afterwards, and the session was asked again.
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.focus(),
    );
    await page.keyboard.type("Bonjour");
    await press(page, "Enter", ["Control"]);
    await waitFor(
      page,
      () => document.querySelector('.pane-panel [role="alert"] a')?.textContent === "Sign in",
    );
    assertStringIncludes(await text(page, '.pane-panel [role="alert"]'), "You need to sign in");
    const signIn = await page.evaluate(() =>
      document
        .querySelector<HTMLAnchorElement>('.pane-panel [role="alert"] a')!
        .getAttribute("href"),
    );
    assertEquals(signIn, `/signin?next=${encodeURIComponent(`/translate/fr?id=${target.id}`)}`);
    const after = await counts();
    assertEquals(after.saves, before.saves + 1);
    assert(after.sessions > before.sessions, "the session wasn't fetched again");

    // Signed out meanwhile: the header says so at once, and the panel invites to sign in.
    await page.evaluate(() => fetch("/test/sign-out"));
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>(".pane-panel textarea")!.focus(),
    );
    await press(page, "Enter", ["Control"]);
    await waitFor(page, () => document.querySelector(".header a.btn")?.textContent === "Sign in");
    await waitFor(page, () => document.querySelector(".pane-panel .signin-prompt") !== null);
    // The only problems are the refused saves.
    assertEquals(
      tab.problems.filter((p) => !/status of 401 .*\/translations\/fr\)$/.test(p)),
      [],
    );
  },
);

browserTest(
  "setup key: missing configuration explains how to enable setup",
  { unclaimed: true, env: { SETUP_KEY: "" } },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/settings");
    await waitFor(page, () => location.pathname === "/setup");
    assertStringIncludes(
      await text(page, "main"),
      "Set SETUP_KEY to at least 16 random characters",
    );
    assertEquals(await page.$("main form"), null);
    assertEquals(problems, []);
  },
);

browserTest(
  "setup key: entered privately in the form and setup closes after completion",
  {
    unclaimed: true,
    env: { SETUP_KEY: "browser-test-setup-key" },
    async prepare(service) {
      await service.ensureSetupToken(SYSTEM, { token: "browser-test-setup-key" });
    },
  },
  async ({ server, browser }) => {
    const { page, problems } = await openTab(browser, server, "/setup?token=ignored");
    await waitFor(page, () => document.querySelector("main form") !== null);
    const inputs = await page.$$("main input");
    await inputs[0].type("browser-test-setup-key");
    await inputs[1].type("Setup project");
    await inputs[3].type("Project Owner");
    await inputs[4].type("owner@example.com");
    await inputs[5].type("correct horse battery");
    await press(page, "Enter");
    await waitFor(page, () => location.pathname === "/");
    assertEquals((await server.service.getSession(SYSTEM, {})).setupRequired, false);
    assertEquals((await fetch(`${server.url}/setup`)).status, 404);
    assertEquals(problems, []);
  },
);
