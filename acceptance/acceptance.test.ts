// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
/// <reference lib="dom" />
/** Black-box release checks. Use only public HTTP, the shipped CLI and a browser. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { launch } from "puppeteer";

const args: string[] = JSON.parse(process.env.QUASO_ACCEPTANCE_ARGS ?? "[]");
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const name = args[i];
  if (!["--url", "--setup-key", "--compose-dir"].includes(name) || !args[i + 1]) {
    throw new Error(
      "Usage: deno task acceptance --url URL [--setup-key TOKEN] [--compose-dir DIR]",
    );
  }
  options.set(name, args[i + 1]);
}
const url = (options.get("--url") ?? "http://localhost:8000").replace(/\/$/, "");
const root = fromFileUrl(new URL("..", import.meta.url));
const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const password = `Acceptance-${crypto.randomUUID()}`;
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

test(`acceptance 1–11 against ${url}`, { timeout: 300000 }, async (t) => {
  const admin = new Client();
  const publicClient = new Client();
  const session = await admin.api<{ setupRequired: boolean; dev: boolean; humanCheck: unknown }>(
    "/auth/session",
  );
  if (session.setupRequired) {
    const token = options.get("--setup-key") ?? process.env["QUASO_SETUP_KEY"];
    assert(
      token,
      "Fresh instance: provide --setup-key or QUASO_SETUP_KEY from deployment configuration.",
    );
    await admin.api("/auth/setup", "POST", {
      token,
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

  const token = await admin.api<{ id: number; secret: string }>("/api-tokens", "POST", {
    name: `Acceptance ${runId}`,
    scope: "upload",
  });
  const cliClient = new Client();
  cliClient.key = token.secret;
  const temp = await Deno.makeTempDir({ prefix: "quaso-acceptance-" });
  const file = (name: string) => `acceptance-${runId}-${name}.json`;
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  const sourceDir = join(temp, "src/locales/en");
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
  async function cli(...args: string[]) {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(root, "packages/cli/dist/quaso.mjs"), ...args],
      cwd: temp,
      env: { QUASO_HOSTNAME: url, QUASO_API_KEY: token.secret },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, `CLI ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
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
    const result = await cliClient.api<Exported>(
      `/export?languages=${language}&files=${file(name)}`,
    );
    assertEquals(result.files.length, 1);
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
  try {
    await t.test(
      "1. Restart preserves project data",
      { timeout: 300000, skip: !options.has("--compose-dir") },
      async () => {
        await upload("restart", { hello: "Hello restart" });
        await importBlue("restart", { hello: "Hallo Neustart" });
        const before = await exported("restart");
        const restart = await new Deno.Command("docker", {
          args: ["compose", "restart", "quaso"],
          cwd: options.get("--compose-dir"),
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(restart.success, new TextDecoder().decode(restart.stderr));
        await until(async () => {
          try {
            const r = await fetch(`${url}/healthz`);
            await r.body?.cancel();
            return r.ok;
          } catch {
            return false;
          }
        });
        assertEquals(await exported("restart"), before);
      },
    );
    if (!options.has("--compose-dir")) {
      console.log("SKIP 1: restart requires --compose-dir; HTTP alone cannot restart an instance.");
    }

    await t.test(
      "2. CLI uploads appear publicly as untranslated",
      { timeout: 300000 },
      async () => {
        await fs.writeFile(join(sourceDir, file("upload")), json({ hello: "Hello upload" }));
        await cli("upload", "--file", file("upload"));
        const rows = await strings("upload");
        assertEquals(rows.length, 1);
        // An automatic translator may already have finished by the time the CLI exits.
        assert(rows[0].translation === null || rows[0].translation.colour === "green");
        const browser = await launch({
          headless: true,
          args: process.env["CI"] ? ["--no-sandbox"] : [],
        });
        try {
          const page = await browser.newPage();
          await page.goto(`${url}/languages/de?file=${encodeURIComponent(file("upload"))}`);
          assertStringIncludes(await page.evaluate(() => document.body.innerText), "German");
        } finally {
          await browser.close();
        }
      },
    );
    const project = await publicClient.api<{ llmAvailable: boolean }>("/project");
    const settings = await admin.api<{ settings: { llm: { autoTranslate: boolean } } }>(
      "/settings",
    );
    const llm = project.llmAvailable && settings.settings.llm.autoTranslate;
    await t.test(
      "3. Automatic translations finish within one minute",
      { timeout: 300000, skip: !llm },
      async () => {
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
    if (!llm) {
      console.log("SKIP 3: no translator configured or automatic translation is disabled.");
    }

    await t.test(
      "4. Volunteer correction is exported only after approval",
      { timeout: 300000, skip: !!session.humanCheck },
      async () => {
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
        assertEquals((await exported("review")).hello, "Alte Übersetzung");
        await admin.api("/suggestions/review", "POST", {
          ids: [suggestion.id],
          action: "approve",
        });
        assertEquals((await exported("review")).hello, "Geprüfte Übersetzung");
        assertEquals((await strings("review"))[0].translation?.colour, "blue");
        await person.api("/account", "DELETE", { confirm: "delete", password });
      },
    );
    await t.test(
      "5. CLI downloads are byte-stable and include fallback English",
      { timeout: 300000 },
      async () => {
        await fs.writeFile(join(sourceDir, file("download")), json({ hello: "Hello download" }));
        await cli("upload", "--file", file("download"), "--wait");
        await cli("download");
        const target = join(temp, "src/locales/de", file("download"));
        const first = await fs.readFile(target);
        assert(first.length > 0);
        if (!project.llmAvailable) {
          assertEquals(JSON.parse(new TextDecoder().decode(first)).hello, "Hello download");
        }
        await cli("download");
        assertEquals(await fs.readFile(target), first);
      },
    );
    await t.test(
      "6. Download never changes English source bytes",
      { timeout: 300000 },
      async () => {
        const path = join(sourceDir, file("untouched"));
        const source = '{ "hello" : "Keep my formatting" }\r\n';
        await fs.writeFile(path, source);
        await cli("upload", "--file", file("untouched"));
        await cli("download");
        assertEquals(await fs.readFile(path, "utf8"), source);
      },
    );
    await t.test(
      "7. Changed English marks old proofread text outdated and preserves export",
      { timeout: 300000 },
      async () => {
        await upload("outdated", { hello: "Hello first" });
        await importBlue("outdated", { hello: "Bewahrter Text" });
        await upload("outdated", { hello: "Hello changed" });
        assertEquals((await strings("outdated"))[0].translation?.outdated, true);
        assertEquals((await exported("outdated")).hello, "Bewahrter Text");
      },
    );
    await t.test("8. Polish export has all four plural forms", { timeout: 300000 }, async () => {
      await upload("plural", { coins_one: "{{count}} coin", coins_other: "{{count}} coins" });
      const value = await exported("plural", "pl");
      assertEquals(Object.keys(value).sort(), [
        "coins_few",
        "coins_many",
        "coins_one",
        "coins_other",
      ]);
      for (const text of Object.values(value)) assertStringIncludes(String(text), "{{count}}");
    });
    await t.test(
      "9. Human translations cannot drop a placeholder",
      { timeout: 300000 },
      async () => {
        await upload("placeholder", { hello: "Hello {{name}}" });
        const [row] = await strings("placeholder");
        const response = await admin.response(`/strings/${row.id}/translations/de`, "PUT", {
          value: "Hallo",
          baseRevision: row.translation?.revision ?? 0,
        });
        const body = await response.json();
        assertEquals(response.status, 422);
        assertEquals(body.error.code, "qa_failed");
      },
    );
    await t.test(
      "10. Signup, volunteer approval, and pending translation",
      { timeout: 300000, skip: !!session.humanCheck },
      async () => {
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
        assertEquals(result.status, "pending");
        await person.api("/account", "DELETE", { confirm: "delete", password });
      },
    );
    if (session.humanCheck) {
      console.log(
        "SKIP 4, 10: real human-check challenge enabled; use staging test credentials or the independent browser fixture suite.",
      );
    }
    await t.test(
      "11. Anonymous visitors browse the project and strings",
      { timeout: 300000 },
      async () => {
        await upload("public", { hello: "Hello visitor" });
        assertEquals((await strings("public"))[0].key, "hello");
        const browser = await launch({
          headless: true,
          args: process.env["CI"] ? ["--no-sandbox"] : [],
        });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "networkidle0" });
          assertStringIncludes(await page.evaluate(() => document.body.innerText), "German");
          assertEquals(await page.evaluate(() => document.querySelectorAll("main").length), 1);
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await admin.api(`/api-tokens/${token.id}`, "DELETE");
    await fs.rm(temp, { recursive: true });
  }
});
