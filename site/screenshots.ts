// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Capture the real app and Quaso Quest: deno run -A site/screenshots.ts.
 * Install the game dependencies first with npm ci --prefix examples/demo-game.
 */
import { type Actor, ANONYMOUS, SYSTEM } from "@quaso/service";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { ensureWebsiteBuilt, openBrowser, waitFor, WEB_DIST } from "../e2e/_setup.ts";
import { type App, createApp } from "../packages/server/src/app.ts";
import { readProjectFiles } from "../packages/server/src/dev_seed.ts";
import { memoryLogger, testConfig } from "../packages/server/src/testing/helpers.ts";
import { realService } from "../packages/server/src/testing/real_service.ts";

// These translations belong to the actual playable example's French catalogs. Keep the
// example's tracked English files empty: the capture imports them into an isolated Quaso
// instance, then feeds its exported files to Vite without changing the game on disk.
const english = {
  "common.json": {
    edition: "THE LITTLE ADVENTURES",
    eyebrow: "AN ADVENTURE TO SAVOUR",
    tagline: "One cat. One croissant. One very buttery mission.",
    language: "Game language",
    soundOn: "Turn on the little sounds",
    soundOff: "Turn off the little sounds",
    seal: { line1: "MADE WITH", line2: "100%", line3: "PURE BUTTER" },
    controls: {
      move: "move",
      space: "space",
      dash: "dash / dodge",
      click: "or click where you want to go",
    },
    footer: "A little game made with love and plenty of butter.",
    translation: {
      title: "Does this little game speak your language?",
      body: "Quaso Quest is also a translation playground. French is ready; English and German are waiting for your words.",
      workflow:
        "Upload the text to your Quaso instance, translate it, then download it and reload the game.",
      fallback: "Untranslated text appears in French. Give it some new words!",
      readme: "Open the translation guide ↗",
    },
  },
  "game.json": {
    chapter: "CHAPTER 01 · SNACK TIME",
    place: "The butter meadow",
    world:
      "The meadow. Move Quaso with the arrows, ZQSD, WASD, or click in the grass. Space to dash, Escape to pause.",
    welcome: {
      kicker: "LITTLE CAT, BIG APPETITE",
      title: "Snack time won't wait!",
      body: "Collect {{total}} pats of butter and meet Biscotte in {{seconds}} seconds. Watch out for the bees: you have three lives!",
      start: "Let's go!",
      note: "The ultimate challenge: {{gold}} points, no stings.",
      rule: "Dash to dodge. Collect butter within 2 seconds to build your combo up to ×5.",
    },
    quest: {
      label: "TODAY'S MISSION",
      collect: "Butter for Biscotte!",
      return: "Go back to Biscotte at the picnic!",
      done: "Happiness is made of butter.",
      progress: "{{current}} / {{total}}",
      butter_zero: "No pats of butter. Yet!",
      butter_one: "{{count}} pat of butter in your pocket.",
      butter_other: "{{count}} pats of butter in your pocket.",
      retry: "Butter deserves a second chance.",
    },
    score: "{{score}} points",
    best: "Best: {{score}}",
    dash: "Butter dash",
    dashReady: "Dodge ready: bees cannot sting you while you dash.",
    dashWait: "Recharging the butter…",
    pet: "Pet Quaso",
    dog: "Talk to Monsieur Biscotte",
    meows: ["Meow-so!", "Pure butter purrs.", "I am a companion pastry.", "Do not dip in coffee."],
    biscotte: {
      waiting: "I've got the bread. Have you got the butter?",
      almost: "{{count}} more! I'll watch the toast.",
      ready: "Over here, little croissant!",
      thanks: "A cat that brings back butter. What a time to be alive!",
    },
    combo: "Pure butter ×{{count}}!",
    pickup: "+{{points}}",
    return: "Your pocket is full! Back to the picnic!",
    pause: {
      button: "Take a break",
      title: "Toast break.",
      body: "Even croissants need a breather.",
      resume: "Back to it!",
    },
    time: { label: "TIME", remaining: "{{count}} s" },
    chain: "COMBO ×{{count}} / {{max}}",
    hit: "Ouch! The croissant strikes back. Dash to dodge!",
    lives_zero: "No lives left",
    lives_one: "{{count}} life left",
    lives_other: "{{count}} lives left",
  },
};

await ensureWebsiteBuilt();
const real = await realService({ dev: true });
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
let gameServer: ViteDevServer | undefined;
let app: App;
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) =>
  app(request),
);
const url = `http://127.0.0.1:${server.addr.port}`;
const directory = fromFileUrl(new URL("./public/screenshots/", import.meta.url));
const gameDirectory = fromFileUrl(new URL("../examples/demo-game/", import.meta.url));
try {
  await real.service.updateSettings(SYSTEM, {
    name: "Quaso Quest",
    description:
      "A cat. A croissant. A very buttery adventure. Help bring Quaso Quest to more players.",
    llm: { autoTranslate: false },
  });
  const { config, sources } = await readProjectFiles(gameDirectory);
  await real.service.upload(SYSTEM, {
    files: sources,
    sourceLanguage: config.sourceLanguage,
    languages: config.languages,
    limits: config.limits,
  });
  for (const [path, content] of Object.entries(english)) {
    const imported = await real.service.importTranslations(SYSTEM, {
      language: "en",
      files: [{ path, content: JSON.stringify(content) }],
      as: path === "common.json" ? "blue" : "green",
      keepIdentical: true,
    });
    if (imported.refused.length) {
      throw new Error(
        `Screenshot translations failed quality checks: ${JSON.stringify(imported.refused)}`,
      );
    }
  }
  const developer = await real.service.ensureDevAccount(SYSTEM, {});
  const admin: Actor = { type: "user", userId: developer.id };
  const volunteer = await real.service.signUp(ANONYMOUS, {
    email: "alex@example.com",
    displayName: "Alex · community translator",
    password: crypto.randomUUID() + crypto.randomUUID(),
  });
  await real.service.signOut(SYSTEM, { sessionId: volunteer.sessionId });
  const contributor: Actor = { type: "user", userId: volunteer.user.id };
  await real.service.requestVolunteer(contributor, {
    languages: ["en"],
    message: "I'd love to help translate Quaso Quest into English.",
  });
  await real.service.reviewVolunteer(admin, {
    userId: volunteer.user.id,
    approve: true,
    languages: ["en"],
  });
  const strings = await real.service.listStrings(ANONYMOUS, {
    language: "en",
    file: "game.json",
    limit: 500,
  });
  for (const [key, value] of [
    ["win.again", "One more slice!"],
    ["win.kicker", "MISSION DELICIOUSLY ACCOMPLISHED"],
    ["lose.retry", "Let's try again!"],
  ]) {
    const string = strings.strings.find((entry) => entry.key === key);
    if (!string) throw new Error(`The example game no longer has ${key}`);
    await real.service.suggest(contributor, {
      id: string.id,
      language: "en",
      kind: "translation",
      value,
      baseRevision: 0,
    });
  }
  app = createApp({
    config: testConfig({ QUASO_DEV: "1", PUBLIC_URL: url, WEB_DIR: WEB_DIST }),
    service: real.service,
    log: memoryLogger(),
  });
  await fs.mkdir(directory, { recursive: true });
  const body = strings.strings.find((string) => string.key === "welcome.body");
  const plural = strings.strings.find((string) => string.key === "quest.butter");
  if (!body || !plural) throw new Error("The example game is missing the featured strings");
  const editor = `/translate/en?file=game.json&id=${body.id}`;
  const views = [
    { name: "dashboard", path: "/", theme: "light", ready: "English" },
    { name: "editor-en", path: editor, theme: "light", ready: "Collect {{total}} pats of butter" },
    { name: "editor-dark", path: editor, theme: "dark", ready: "Collect {{total}} pats of butter" },
    {
      name: "editor-plurals",
      path: `/translate/en?file=game.json&id=${plural.id}`,
      theme: "light",
      ready: "pat of butter in your pocket",
    },
    { name: "review", path: "/review", theme: "light", ready: "One more slice!" },
  ];
  for (const view of views) {
    // A separate browser for each capture keeps the renderer and viewport independent.
    browser = await openBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument((theme) => {
      localStorage.setItem("quaso.theme", theme);
    }, view.theme);
    const problems: string[] = [];
    page.on("pageerror", (event) => problems.push(String(event)));
    await page.goto(`${url}/auth/dev-login`, { waitUntil: "networkidle0" });
    if (view.path !== "/") await page.goto(`${url}${view.path}`, { waitUntil: "networkidle0" });
    await waitFor(
      page,
      (ready: string) => {
        const values = [...document.querySelectorAll("textarea")]
          .map((input) => input.value)
          .join(" ");
        return (document.querySelector("main")?.textContent + " " + values).includes(ready);
      },
      [view.ready],
    );
    await page.evaluate(() => document.fonts.ready);
    if (problems.length) throw new Error(problems.join("\n"));
    await fs.writeFile(
      `${directory}/${view.name}.png`,
      await page.screenshot({ type: "png", captureBeyondViewport: false }),
    );
    console.log(`Captured ${view.name}.png`);
    await browser.close();
    browser = undefined;
  }

  // Render the actual game using the same English files that Quaso's download API exports.
  const exported = await real.service.exportFiles(admin, { languages: ["en"] });
  const catalogs = new Map(
    exported.files.map((file) => [join(gameDirectory, "src/locales/en", file.path), file.content]),
  );
  gameServer = await createServer({
    configFile: false,
    root: gameDirectory,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "quaso-screenshot-translations",
        enforce: "pre",
        load(id) {
          return catalogs.get(id.split("?")[0]) ?? null;
        },
      },
    ],
  });
  await gameServer.listen();
  const gameAddress = gameServer.httpServer?.address();
  if (!gameAddress || typeof gameAddress === "string") throw new Error("No game server address");
  browser = await openBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  const problems: string[] = [];
  page.on("pageerror", (event) => problems.push(String(event)));
  await page.goto(`http://127.0.0.1:${gameAddress.port}/?lang=en`, { waitUntil: "networkidle0" });
  await waitFor(page, () => document.getElementById("start")?.textContent?.includes("Let's go!"));
  await page.evaluate(() => document.fonts.ready);
  if (problems.length) throw new Error(problems.join("\n"));
  const game = await page.$(".game-shell");
  if (!game) throw new Error("The example game's play area is missing");
  await fs.writeFile(`${directory}/quaso-quest.png`, await game.screenshot({ type: "png" }));
  console.log("Captured quaso-quest.png with Quaso's exported English translations");
} finally {
  await browser?.close();
  await gameServer?.close();
  await server.shutdown();
  real.close();
}
