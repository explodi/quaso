// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  createFakeTranslator,
  ProviderError,
  type ProviderRequest,
  type TranslationProvider,
} from "@quaso/service";
import { CONFIG, runCli, withProject, writeFiles } from "./test_helpers.ts";

const ENV = { GEMINI_API_KEY: "test-key" };

const PROJECT = {
  "quaso.config.json": { ...CONFIG, languages: ["de"] },
  "src/locales/en/common.json": '{ "title": "Quest", "ok": "OK" }\n',
};

/** The fake translator, recording the requests it gets. */
function recordingProvider() {
  const fake = createFakeTranslator();
  const requests: ProviderRequest[] = [];
  const provider: TranslationProvider = {
    ...fake,
    translate(request) {
      requests.push(request);
      return fake.translate(request);
    },
  };
  return { requests, llmProvider: () => provider };
}

async function readJson(dir: string, path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(join(dir, ...path.split("/")), "utf8"));
}

test("translate without an instance writes the translation files", async () => {
  await withProject(PROJECT, async (dir) => {
    const { llmProvider } = recordingProvider();
    const run = await runCli(["translate"], { cwd: dir, env: ENV, llmProvider });
    expect(run.code, run.stderr).toBe(0);
    expect(await readJson(dir, "src/locales/de/common.json")).toStrictEqual({
      title: "[Ǫúéśţ]",
      ok: "[ÖĶ]",
    });
    expect(run.stdout).toContain("created  src/locales/de/common.json");
    expect(run.stdout).toContain("Wrote 1 file, 0 unchanged.");
  });
});

test("a second run translates nothing and writes nothing", async () => {
  await withProject(PROJECT, async (dir) => {
    await runCli(["translate"], { cwd: dir, env: ENV, ...recordingProvider() });
    const second = recordingProvider();
    const run = await runCli(["translate"], { cwd: dir, env: ENV, ...second });
    expect(run.code, run.stderr).toBe(0);
    expect(second.requests).toStrictEqual([]);
    expect(run.stdout).toContain("Nothing to translate: every string in scope is translated.");
    expect(run.stdout).toContain("Wrote 0 files, 1 unchanged.");
  });
});

test("only the string whose source text changed is translated again", async () => {
  await withProject(PROJECT, async (dir) => {
    await runCli(["translate"], { cwd: dir, env: ENV, ...recordingProvider() });
    await writeFiles(dir, {
      "src/locales/en/common.json": '{ "title": "Journey", "ok": "OK" }\n',
    });
    const second = recordingProvider();
    const run = await runCli(["translate"], { cwd: dir, env: ENV, ...second });
    expect(run.code, run.stderr).toBe(0);
    expect(second.requests.map((request) => request.batch?.strings.length)).toStrictEqual([1]);
    expect(await readJson(dir, "src/locales/de/common.json")).toStrictEqual({
      title: "[Ĵöúŕñéý]",
      ok: "[ÖĶ]",
    });
  });
});

test("a translation someone wrote in the repository is kept", async () => {
  await withProject(
    { ...PROJECT, "src/locales/de/common.json": '{ "title": "Abenteuer" }\n' },
    async (dir) => {
      const run = await runCli(["translate"], { cwd: dir, env: ENV, ...recordingProvider() });
      expect(run.code, run.stderr).toBe(0);
      expect(await readJson(dir, "src/locales/de/common.json")).toStrictEqual({
        title: "Abenteuer",
        ok: "[ÖĶ]",
      });
    },
  );
});

test("source text written in place of a missing translation is translated", async () => {
  await withProject(
    { ...PROJECT, "src/locales/de/common.json": '{ "title": "Quest", "ok": "OK" }\n' },
    async (dir) => {
      const run = await runCli(["translate"], { cwd: dir, env: ENV, ...recordingProvider() });
      expect(run.code, run.stderr).toBe(0);
      expect(await readJson(dir, "src/locales/de/common.json")).toStrictEqual({
        title: "[Ǫúéśţ]",
        ok: "[ÖĶ]",
      });
    },
  );
});

test("the lock records the source text each translation was made for", async () => {
  await withProject(PROJECT, async (dir) => {
    await runCli(["translate"], { cwd: dir, env: ENV, ...recordingProvider() });
    expect(await readJson(dir, "quaso.lock.json")).toStrictEqual({
      version: 1,
      translations: {
        de: {
          "common.json": { '["title"]': "bd08de42dce840bb", '["ok"]': "98c4922bb641c65c" },
        },
      },
    });
  });
});

test("the prompt carries the config's settings and the context files", async () => {
  const project = {
    ...PROJECT,
    "quaso.config.json": {
      ...CONFIG,
      languages: ["de"],
      settings: {
        name: "Quaso Quest",
        llm: { projectInstructions: "Keep it playful." },
        languages: { de: { instructions: "Use du." } },
      },
    },
    "src/locales/en/common.json.quaso": "Titles of the main menu.\n",
    "src/locales/en/context.quaso": "A game about pastry.\n",
  };
  await withProject(project, async (dir) => {
    const provider = recordingProvider();
    const run = await runCli(["translate"], { cwd: dir, env: ENV, ...provider });
    expect(run.code, run.stderr).toBe(0);
    const [request] = provider.requests;
    expect(request.system).toContain("You translate the texts of Quaso Quest");
    expect(request.system).toContain("Keep it playful.");
    expect(request.system).toContain("Use du.");
    expect(request.prompt).toContain("A game about pastry.\n\nTitles of the main menu.");
  });
});

test("--dry-run estimates and writes nothing", async () => {
  await withProject(PROJECT, async (dir) => {
    const provider = recordingProvider();
    const run = await runCli(["translate", "--dry-run"], { cwd: dir, env: ENV, ...provider });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("Dry run: nothing was translated.");
    expect(run.stdout).toContain("de  2 strings  2 words");
    expect(provider.requests).toStrictEqual([]);
    await expect(fs.stat(join(dir, "src/locales/de/common.json"))).rejects.toThrow();
    await expect(fs.stat(join(dir, "quaso.lock.json"))).rejects.toThrow();
  });
});

test("--file translates only that file", async () => {
  const project = { ...PROJECT, "src/locales/en/menu.json": '{ "play": "Play" }\n' };
  await withProject(project, async (dir) => {
    const run = await runCli(["translate", "--file", "menu.json"], {
      cwd: dir,
      env: ENV,
      ...recordingProvider(),
    });
    expect(run.code, run.stderr).toBe(0);
    expect(await readJson(dir, "src/locales/de/menu.json")).toStrictEqual({ play: "[Þļáý]" });
    await expect(fs.stat(join(dir, "src/locales/de/common.json"))).rejects.toThrow();
  });
});

test("without an LLM key, translate says which variables to set", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["translate"], { cwd: dir, env: {} });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("GEMINI_API_KEY and ANTHROPIC_API_KEY aren't set.");
  });
});

test("--local translates here although the config names an instance", async () => {
  const project = {
    ...PROJECT,
    "quaso.config.json": { ...CONFIG, languages: ["de"], hostname: "quaso.test" },
  };
  await withProject(project, async (dir) => {
    const run = await runCli(["translate", "--local"], {
      cwd: dir,
      env: ENV,
      ...recordingProvider(),
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("created  src/locales/de/common.json");
  });
});

test("--no-wait is refused without an instance", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["translate", "--no-wait"], { cwd: dir, env: ENV });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--no-wait needs an instance");
  });
});

test("--json reports the job and the files written", async () => {
  await withProject(PROJECT, async (dir) => {
    const run = await runCli(["translate", "--json"], {
      cwd: dir,
      env: ENV,
      ...recordingProvider(),
    });
    expect(run.code, run.stderr).toBe(0);
    const { result } = JSON.parse(run.stdout);
    expect(result.local).toBe(true);
    expect(result.job.progress.translated).toBe(2);
    expect(result.written).toStrictEqual([
      { path: "src/locales/de/common.json", language: "de", change: "created" },
    ]);
  });
});

test("a key the provider refuses stops the run and says why", async () => {
  await withProject(PROJECT, async (dir) => {
    const refusing: TranslationProvider = {
      ...createFakeTranslator(),
      translate: () => Promise.reject(new ProviderError("auth", "The API key was refused.")),
    };
    const run = await runCli(["translate"], { cwd: dir, env: ENV, llmProvider: () => refusing });
    expect(run.code).toBe(6);
    expect(run.stdout).toContain("The translation paused: the AI provider API key was refused");
    expect(run.stdout).toContain("0 translated");
  });
});
