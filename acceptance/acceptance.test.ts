// SPDX-License-Identifier: MIT
/** Black-box release checks. Use only public HTTP, the shipped CLI and a browser. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { launch } from "puppeteer";
import { afterAll, assert, beforeAll, describe, expect, test } from "vitest";

const args: string[] = JSON.parse(process.env.QUASO_ACCEPTANCE_ARGS ?? "[]");
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const name = args[i];
  if (!["--url", "--setup-key", "--compose-dir"].includes(name) || !args[i + 1]) {
    throw new Error(
      "Usage: npm run acceptance -- --url URL [--setup-key TOKEN] [--compose-dir DIR]",
    );
  }
  options.set(name, args[i + 1]);
}
const url = (options.get("--url") ?? "http://localhost:8000").replace(/\/$/, "");
const root = fromFileUrl(new URL("..", import.meta.url));
const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const password = `Acceptance-${crypto.randomUUID()}`;
const STEP_TIMEOUT = 300_000;
type StringRow = {
  id: number;
  key: string;
  translation: null | { value: unknown; colour: string; outdated: boolean; revision: number };
};
type Exported = { files: { path: string; language: string; content: string }[] };

class Client {
  cookie = "";
  key = "";
  async response(path: string, method = "GET", body?: unknown): Promise<Response> {
    const response = await fetch(`${url}${path === "/auth/dev-login" ? path : `/api/v1${path}`}`, {
      method,
      redirect: "manual",
      headers: {
        Origin: url,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0];
    return response;
  }
  async api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.response(path, method, body);
    const text = await response.text();
    assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}

async function until(check: () => Promise<boolean>, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Condition did not become true within ${timeout} ms`);
}

// The steps share one instance, signed in once; vitest runs them in order.
const admin = new Client();
const publicClient = new Client();
const cliClient = new Client();
let session: { setupRequired: boolean; dev: boolean; humanCheck: unknown };
let token: { id: number; secret: string };
let project: { llmAvailable: boolean };
let llm: boolean;
let temp: string;
let sourceDir: string;

const file = (name: string) => `acceptance-${runId}-${name}.json`;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function cli(...args: string[]) {
  const out = spawnSync(process.execPath, [join(root, "packages/cli/dist/quaso.mjs"), ...args], {
    cwd: temp,
    env: { ...process.env, QUASO_HOSTNAME: url, QUASO_API_KEY: token.secret },
    encoding: "utf8",
  });
  assert(out.status === 0, `CLI ${args.join(" ")}: ${out.stderr}`);
}
async function upload(name: string, content: Record<string, string>) {
  return await cliClient.api<{ job: { id: number } | null }>("/sources", "POST", {
    files: [{ path: file(name), repoPath: file(name), content: json(content) }],
    partial: true,
    languages: ["de", "fr", "pl"],
  });
}
async function strings(name: string, language = "de") {
  return (
    await publicClient.api<{ strings: StringRow[] }>(
      `/strings?language=${language}&file=${file(name)}&limit=100`,
    )
  ).strings;
}
async function exported(name: string, language = "de") {
  const result = await cliClient.api<Exported>(`/export?languages=${language}&files=${file(name)}`);
  expect(result.files.length).toBe(1);
  return JSON.parse(result.files[0].content);
}
async function importBlue(name: string, content: Record<string, string>) {
  await cliClient.api("/imports", "POST", {
    language: "de",
    as: "blue",
    overwrite: true,
    files: [{ path: file(name), content: json(content) }],
  });
}
async function volunteer() {
  const person = new Client();
  const info = await person.api<{ user: { id: number } }>("/auth/signup", "POST", {
    email: `acceptance-${crypto.randomUUID()}@example.com`,
    password,
    displayName: `Volunteer ${runId}`,
  });
  await person.api("/volunteer-requests", "POST", {
    languages: ["de", "fr"],
    message: "Automated acceptance test",
  });
  await admin.api(`/team/volunteer-requests/${info.user.id}`, "POST", {
    approve: true,
    role: "contributor",
    languages: ["de", "fr"],
  });
  return person;
}

async function signInAdmin() {
  session = await admin.api("/auth/session");
  if (session.setupRequired) {
    const setupKey = options.get("--setup-key") ?? process.env["QUASO_SETUP_KEY"];
    assert(
      setupKey,
      "Fresh instance: provide --setup-key or QUASO_SETUP_KEY from deployment configuration.",
    );
    await admin.api("/auth/setup", "POST", {
      token: setupKey,
      email: process.env["QUASO_ADMIN_EMAIL"] ?? `acceptance-admin-${runId}@example.com`,
      password: process.env["QUASO_ADMIN_PASSWORD"] ?? password,
      displayName: "Acceptance administrator",
      projectName: "Acceptance project",
    });
  } else if (process.env["QUASO_ADMIN_EMAIL"] && process.env["QUASO_ADMIN_PASSWORD"]) {
    await admin.api("/auth/signin", "POST", {
      email: process.env["QUASO_ADMIN_EMAIL"],
      password: process.env["QUASO_ADMIN_PASSWORD"],
    });
  } else if (session.dev) {
    const login = await admin.response("/auth/dev-login");
    await login.body?.cancel();
    assert(admin.cookie, "Development login must set a session cookie");
  } else throw new Error("Claimed instance: set QUASO_ADMIN_EMAIL and QUASO_ADMIN_PASSWORD.");
}

describe(`acceptance 1–11 against ${url}`, () => {
  beforeAll(async () => {
    await signInAdmin();
    token = await admin.api("/api-tokens", "POST", {
      name: `Acceptance ${runId}`,
      scope: "upload",
    });
    cliClient.key = token.secret;
    project = await publicClient.api("/project");
    const settings = await admin.api<{ settings: { llm: { autoTranslate: boolean } } }>(
      "/settings",
    );
    llm = project.llmAvailable && settings.settings.llm.autoTranslate;
    temp = await fs.mkdtemp(join(tmpdir(), "quaso-acceptance-"));
    sourceDir = join(temp, "src/locales/en");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      join(temp, "quaso.config.json"),
      json({
        hostname: url,
        sourceLanguage: "en",
        languages: ["de", "fr", "pl"],
        files: [{ source: "src/locales/en/*.json", translation: "src/locales/{lang}/{path}" }],
      }),
    );
  });

  afterAll(async () => {
    if (token) await admin.api(`/api-tokens/${token.id}`, "DELETE");
    if (temp) await fs.rm(temp, { recursive: true });
  });

  test("1. Restart preserves project data", { timeout: STEP_TIMEOUT }, async ({ skip }) => {
    skip(
      !options.has("--compose-dir"),
      "restart requires --compose-dir; HTTP alone cannot restart an instance.",
    );
    await upload("restart", { hello: "Hello restart" });
    await importBlue("restart", { hello: "Hallo Neustart" });
    const before = await exported("restart");
    const restart = spawnSync("docker", ["compose", "restart", "quaso"], {
      cwd: options.get("--compose-dir"),
      encoding: "utf8",
    });
    assert(restart.status === 0, restart.stderr);
    await until(async () => {
      try {
        const r = await fetch(`${url}/healthz`);
        await r.body?.cancel();
        return r.ok;
      } catch {
        return false;
      }
    });
    expect(await exported("restart")).toStrictEqual(before);
  });

  test("2. CLI uploads appear publicly as untranslated", { timeout: STEP_TIMEOUT }, async () => {
    await fs.writeFile(join(sourceDir, file("upload")), json({ hello: "Hello upload" }));
    cli("upload", "--file", file("upload"));
    const rows = await strings("upload");
    expect(rows.length).toBe(1);
    // An automatic translator may already have finished by the time the CLI exits.
    assert(rows[0].translation === null || rows[0].translation.colour === "green");
    const browser = await launch({
      headless: true,
      args: process.env["CI"] ? ["--no-sandbox"] : [],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${url}/languages/de?file=${encodeURIComponent(file("upload"))}`, {
        waitUntil: "networkidle0",
      });
      expect(await page.evaluate(() => document.body.innerText)).toContain("German");
    } finally {
      await browser.close();
    }
  });

  test(
    "3. Automatic translations finish within one minute",
    { timeout: STEP_TIMEOUT },
    async ({ skip }) => {
      skip(!llm, "no translator configured or automatic translation is disabled.");
      const result = await upload("llm", { hello: "Hello translator" });
      assert(result.job);
      await until(async () => {
        const all = await Promise.all(
          ["de", "fr", "pl"].map((language) => strings("llm", language)),
        );
        return all.every((rows) => rows.length === 1 && rows[0].translation?.colour === "green");
      });
    },
  );

  test(
    "4. Volunteer correction is exported only after approval",
    { timeout: STEP_TIMEOUT },
    async ({ skip }) => {
      skip(
        !!session.humanCheck,
        "real human-check challenge enabled; use staging test credentials or the independent browser fixture suite.",
      );
      await upload("review", { hello: "Hello review" });
      await importBlue("review", { hello: "Alte Übersetzung" });
      const person = await volunteer();
      const [row] = await strings("review");
      const suggestion = await person.api<{ id: number }>(
        `/strings/${row.id}/suggestions/de`,
        "POST",
        {
          kind: "correction",
          value: "Geprüfte Übersetzung",
          baseRevision: row.translation?.revision ?? 0,
        },
      );
      expect((await exported("review")).hello).toBe("Alte Übersetzung");
      await admin.api("/suggestions/review", "POST", {
        ids: [suggestion.id],
        action: "approve",
      });
      expect((await exported("review")).hello).toBe("Geprüfte Übersetzung");
      expect((await strings("review"))[0].translation?.colour).toBe("blue");
      await person.api("/account", "DELETE", { confirm: "delete", password });
    },
  );

  test(
    "5. CLI downloads are byte-stable and include fallback English",
    { timeout: STEP_TIMEOUT },
    async () => {
      await fs.writeFile(join(sourceDir, file("download")), json({ hello: "Hello download" }));
      cli("upload", "--file", file("download"), "--wait");
      cli("download");
      const target = join(temp, "src/locales/de", file("download"));
      const first = await fs.readFile(target);
      assert(first.length > 0);
      if (!project.llmAvailable) {
        expect(JSON.parse(new TextDecoder().decode(first)).hello).toBe("Hello download");
      }
      cli("download");
      expect(await fs.readFile(target)).toStrictEqual(first);
    },
  );

  test("6. Download never changes English source bytes", { timeout: STEP_TIMEOUT }, async () => {
    const path = join(sourceDir, file("untouched"));
    const source = '{ "hello" : "Keep my formatting" }\r\n';
    await fs.writeFile(path, source);
    cli("upload", "--file", file("untouched"));
    cli("download");
    expect(await fs.readFile(path, "utf8")).toStrictEqual(source);
  });

  test(
    "7. Changed English marks old proofread text outdated and preserves export",
    { timeout: STEP_TIMEOUT },
    async () => {
      await upload("outdated", { hello: "Hello first" });
      await importBlue("outdated", { hello: "Bewahrter Text" });
      await upload("outdated", { hello: "Hello changed" });
      expect((await strings("outdated"))[0].translation?.outdated).toBe(true);
      expect((await exported("outdated")).hello).toBe("Bewahrter Text");
    },
  );

  test("8. Polish export has all four plural forms", { timeout: STEP_TIMEOUT }, async () => {
    await upload("plural", { coins_one: "{{count}} coin", coins_other: "{{count}} coins" });
    const value = await exported("plural", "pl");
    expect(Object.keys(value).sort()).toStrictEqual([
      "coins_few",
      "coins_many",
      "coins_one",
      "coins_other",
    ]);
    for (const text of Object.values(value)) expect(String(text)).toContain("{{count}}");
  });

  test("9. Human translations cannot drop a placeholder", { timeout: STEP_TIMEOUT }, async () => {
    await upload("placeholder", { hello: "Hello {{name}}" });
    const [row] = await strings("placeholder");
    const response = await admin.response(`/strings/${row.id}/translations/de`, "PUT", {
      value: "Hallo",
      baseRevision: row.translation?.revision ?? 0,
    });
    const body = await response.json();
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("qa_failed");
  });

  test(
    "10. Signup, volunteer approval, and pending translation",
    { timeout: STEP_TIMEOUT },
    async ({ skip }) => {
      skip(
        !!session.humanCheck,
        "real human-check challenge enabled; use staging test credentials or the independent browser fixture suite.",
      );
      await upload("volunteer", { hello: "Hello volunteer" });
      const person = await volunteer();
      const [row] = await strings("volunteer", "fr");
      const result = await person.api<{ status: string }>(
        `/strings/${row.id}/suggestions/fr`,
        "POST",
        {
          kind: "translation",
          value: "Bonjour bénévole",
          baseRevision: row.translation?.revision ?? 0,
        },
      );
      expect(result.status).toBe("pending");
      await person.api("/account", "DELETE", { confirm: "delete", password });
    },
  );

  test(
    "11. Anonymous visitors browse the project and strings",
    { timeout: STEP_TIMEOUT },
    async () => {
      await upload("public", { hello: "Hello visitor" });
      expect((await strings("public"))[0].key).toBe("hello");
      const browser = await launch({
        headless: true,
        args: process.env["CI"] ? ["--no-sandbox"] : [],
      });
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle0" });
        expect(await page.evaluate(() => document.body.innerText)).toContain("German");
        expect(await page.evaluate(() => document.querySelectorAll("main").length)).toStrictEqual(
          1,
        );
      } finally {
        await browser.close();
      }
    },
  );
});
