// SPDX-License-Identifier: MIT
/// <reference lib="dom" />
/** The repository workflow through public HTTP, the built CLI and the real website. */
import { mkdtemp, readFile, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Command } from "@quaso/runtime/command";
import { assert, assertEquals, assertStringIncludes } from "@quaso/runtime/assert";
import type { Browser, Page } from "puppeteer";
import type { JobInfo, JobsResult, ProjectInfo, QuasoConfig, SourceFilesResult } from "@quaso/core";
import type { DownloadResult } from "../packages/cli/src/commands/download.ts";
import { openTab, press, text, waitFor } from "../e2e/_setup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "acceptance/fixtures/workflow");

export interface WorkflowOptions {
  url: string;
  browser: Browser;
  email: string;
  password: string;
  /** Only a fresh, disposable instance may be claimed by this test. */
  setupToken?: string;
  step?(message: string): void;
}

async function api<T>(page: Page, path: string, method = "GET", body?: unknown): Promise<T> {
  return (await page.evaluate(
    async (path, method, body) => {
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    },
    path,
    method,
    body,
  )) as T;
}

async function click(page: Page, label: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    );
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
    button.click();
  }, label);
}

async function until(check: () => Promise<boolean>, description: string) {
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${description}`);
}

/** The caller owns the disposable instance and its LLM stub; this owns its page/key/files. */
export async function runWorkflow(options: WorkflowOptions): Promise<{ job: JobInfo }> {
  const url = options.url.replace(/\/$/, "");
  const workspace = await mkdtemp(join(tmpdir(), "quaso-workflow-"));
  let ownedPage: Page | undefined;
  let keyId: number | undefined;
  try {
    const { page, problems } = await openTab(options.browser, { url }, "/signin", (page) =>
      page.setViewport({ width: 1440, height: 1000 }),
    );
    ownedPage = page;
    const initial = await api<ProjectInfo>(page, "/project");
    assertEquals(initial.details.files, 0, "Use a dedicated empty workflow instance");
    assert(initial.llmAvailable, "The workflow instance needs a deterministic LLM stub");
    const session = await api<{ setupRequired: boolean }>(page, "/auth/session");
    if (session.setupRequired) {
      assert(options.setupToken, "A fresh instance needs its setup token");
      await api(page, "/auth/setup", "POST", {
        token: options.setupToken,
        email: options.email,
        password: options.password,
        displayName: "Workflow Owner",
        projectName: "Workflow fixture",
      });
    }
    await api(page, "/auth/signin", "POST", { email: options.email, password: options.password });
    await api(page, "/settings", "PATCH", {
      llm: { autoTranslate: false, context: { fileContext: false, otherLanguages: [] } },
    });
    const token = await api<{ id: number; secret: string }>(page, "/api-tokens", "POST", {
      name: "Workflow test",
      scope: "upload",
    });
    keyId = token.id;
    await cp(join(FIXTURE, "project"), workspace, { recursive: true });
    const config: QuasoConfig = JSON.parse(
      await readFile(join(workspace, "quaso.config.json"), "utf8"),
    );
    const expected: {
      files: string[];
      newKeys: { file: string; key: string }[];
      changedKey: { file: string; key: string };
    } = JSON.parse(await readFile(join(FIXTURE, "expected.json"), "utf8"));
    const cli = async <T>(...args: string[]): Promise<T> => {
      const output = await new Command("node", {
        args: [join(ROOT, "packages/cli/dist/quaso.mjs"), ...args, "--json"],
        cwd: workspace,
        env: { QUASO_HOSTNAME: url, QUASO_API_KEY: token.secret },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(output.success, `CLI ${args.join(" ")}: ${new TextDecoder().decode(output.stderr)}`);
      return JSON.parse(new TextDecoder().decode(output.stdout)).result as T;
    };
    const source = async (file: string): Promise<Record<string, string>> =>
      JSON.parse(await readFile(join(workspace, "src/locales/en", file), "utf8"));
    const downloaded = async (language: string, file: string): Promise<Record<string, string>> =>
      JSON.parse(
        await readFile(
          join(workspace, "src/locales", config.languageMapping?.[language] ?? language, file),
          "utf8",
        ),
      );

    options.step?.("1. Import approved and full Crowdin exports");
    await cli("upload");
    await cli("import", "--as", "blue", "--from", join(FIXTURE, "crowdin-approved"));
    await cli("import", "--as", "green", "--from", join(FIXTURE, "crowdin-full"));
    const imported = await api<ProjectInfo>(page, "/project");
    assertEquals(
      [imported.details.files, imported.details.strings, imported.details.words],
      [5, 10, 20],
    );
    assertEquals(
      imported.languages.map((language) => language.translatedPercent),
      [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
    );
    assertEquals(
      imported.languages.map((language) => language.blue),
      [2, 10, 2, 2, 2, 2, 2, 2, 2, 2],
    );
    await until(async () => {
      await cli<DownloadResult>("download");
      return (await downloaded("es", "common.json")).start === "[es] Start journey";
    }, "baseline published downloads");
    await page.goto(url, { waitUntil: "networkidle0" });
    await waitFor(page, () => document.querySelectorAll(".language-row").length === 10);
    assertEquals(
      await page.$$eval(
        ".language-row",
        (rows) => rows.filter((row) => row.textContent?.includes("100% translated")).length,
      ),
      10,
    );

    options.step?.("2. Upload five new and one changed string");
    await cp(join(FIXTURE, "updated/src/locales/en"), join(workspace, "src/locales/en"), {
      recursive: true,
    });
    const upload = await cli<{ files: { path: string; added: number; changed: number }[] }>(
      "upload",
    );
    assertEquals(
      upload.files.map((file) => [file.path, file.added, file.changed]),
      [
        ["buildings.json", 1, 0],
        ["common.json", 1, 0],
        ["menu.json", 1, 1],
        ["toolbox.json", 1, 0],
        ["tutorial/steps.json", 1, 0],
      ],
    );
    const updated = await api<ProjectInfo>(page, "/project");
    assertEquals([updated.details.strings, updated.details.words], [15, 31]);
    assertEquals(
      updated.languages.map((language) => language.wordsLeft),
      [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
    );
    await waitFor(
      page,
      () => {
        const rows = [...document.querySelectorAll(".language-row")];
        return (
          rows.length === 10 && rows.every((row) => row.textContent?.includes("10 words left"))
        );
      },
      [],
      45_000,
    );

    options.step?.("3. Browse repository source paths");
    await page.goto(`${url}/sources`, { waitUntil: "networkidle0" });
    await waitFor(page, () => document.querySelectorAll(".tree-counts time").length === 5);
    assert(await page.$('[data-path="src/locales/en/tutorial/"]'));
    const sources = await api<SourceFilesResult>(page, "/files");
    assertEquals(
      sources.files.map((file) => file.repoPath),
      expected.files.map((file) => `src/locales/en/${file}`),
    );

    options.step?.("4. Download English fallbacks, leaving unchanged files alone");
    let firstDownload!: DownloadResult;
    await until(async () => {
      firstDownload = await cli<DownloadResult>("download");
      return (await downloaded("es", "common.json")).reward === "Collect reward";
    }, "updated published downloads");
    assertEquals(firstDownload.written.length, 50);
    for (const language of config.languages) {
      for (const entry of expected.newKeys)
        assertEquals(
          (await downloaded(language, entry.file))[entry.key],
          (await source(entry.file))[entry.key],
        );
    }
    const unchanged = await cli<DownloadResult>("download");
    assertEquals([unchanged.written.length, unchanged.unchanged.length], [0, 50]);

    options.step?.("5. Translate Spanish in opening queue order");
    await page.goto(`${url}/translate/es`, { waitUntil: "networkidle0" });
    await waitFor(
      page,
      () => document.querySelector(".queue-navigation [role=status]")?.textContent === "1 / 6",
    );
    for (const entry of [...expected.newKeys, expected.changedKey]) {
      await waitFor(
        page,
        (key: string) => document.querySelector(".panel-key code")?.textContent === key,
        [entry.key],
      );
      assertStringIncludes(await text(page, ".panel-file"), entry.file);
      await page.focus("[data-translation-input]");
      await press(page, "a", ["Control"]);
      await page.keyboard.type(`[es] ${(await source(entry.file))[entry.key]}`);
      await waitFor(
        page,
        () =>
          document.querySelector<HTMLButtonElement>(".panel-actions .btn-primary")?.disabled ===
          false,
      );
      await press(page, "Enter", ["Control"]);
    }
    await waitFor(
      page,
      () => document.querySelector(".queue-navigation [role=status]")?.textContent === "Done",
    );

    options.step?.("6. Spanish is 100% translated and proofread");
    const spanish = (await api<ProjectInfo>(page, "/project")).languages.find(
      (language) => language.tag === "es",
    )!;
    assertEquals([spanish.translatedPercent, spanish.proofreadPercent], [100, 100]);
    await page.goto(`${url}/languages/es`, { waitUntil: "networkidle0" });
    await waitFor(page, () =>
      document.querySelector("main")?.textContent?.includes("100% translated • 100% proofread"),
    );

    options.step?.("7. Auto-translate with Spanish references and follow progress");
    await api(page, "/settings", "PATCH", { llm: { context: { otherLanguages: ["es"] } } });
    await page.goto(url, { waitUntil: "networkidle0" });
    await click(page, "Auto-translate");
    await waitFor(page, () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.trim() === "Start translation" && !button.disabled,
      ),
    );
    assertStringIncludes(
      await text(page, ".reference-languages"),
      "Spanish (proofread strings marked)",
    );
    assertEquals(
      await page.$eval('[role="tree"][aria-label="Files to translate"] [data-path=""]', (root) =>
        root.getAttribute("aria-checked"),
      ),
      "true",
    );
    await click(page, "Start translation");
    await waitFor(page, () => document.querySelector("dialog[open]") === null);
    await page.goto(`${url}/translate/es`, { waitUntil: "networkidle0" });
    await waitFor(page, () => {
      const bar = document.querySelector<HTMLProgressElement>(".job-indicator progress");
      return !!bar && bar.value > 0 && bar.value < bar.max;
    });
    const jobs = await api<JobsResult>(page, "/jobs");
    const jobId = jobs.jobs[0]!.id;
    await waitFor(
      page,
      () => document.querySelector(".toasts")?.textContent?.includes("Translation finished"),
      [],
      90_000,
    );
    const job = await api<JobInfo>(page, `/jobs/${jobId}`);
    assertEquals(
      [job.status, job.progress.translated, job.progress.proposed, job.progress.failed],
      ["done", 54, 0, 0],
    );

    options.step?.("8. Every language shows 100% translated");
    await page.click('a.brand[href="/"]');
    await waitFor(page, () => document.querySelectorAll(".language-row").length === 10);
    assertEquals(
      await page.$$eval(
        ".language-row",
        (rows) => rows.filter((row) => row.textContent?.includes("100% translated")).length,
      ),
      10,
    );
    const final = await api<ProjectInfo>(page, "/project");
    assertEquals(
      final.languages.map((language) => [language.translatedPercent, language.outdated]),
      [
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
      ],
    );

    options.step?.("9. Download translated new keys and verify repeat writes nothing");
    await until(async () => {
      await cli("download");
      return (await downloaded("de", "common.json")).reward !== "Collect reward";
    }, "completed published translations");
    for (const language of config.languages) {
      for (const entry of expected.newKeys) {
        const value = (await downloaded(language, entry.file))[entry.key];
        assert(
          typeof value === "string" && value !== (await source(entry.file))[entry.key],
          `${language}: ${entry.file}:${entry.key} still English`,
        );
      }
    }
    const repeated = await cli<DownloadResult>("download");
    assertEquals([repeated.written.length, repeated.unchanged.length], [0, 50]);
    assertEquals(problems, []);
    return { job };
  } finally {
    try {
      if (keyId !== undefined && ownedPage) await api(ownedPage, `/api-tokens/${keyId}`, "DELETE");
    } finally {
      try {
        await ownedPage?.close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }
}
