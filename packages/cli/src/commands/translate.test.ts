// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import type { CreateJobRequest, JobEstimate, JobInfo } from "@quaso/core";
import { POLL_INTERVAL_MS } from "../jobs.ts";
import { CONFIG, fakeFetch, jobInfo, jsonResponse, runCli, withProject } from "../test_helpers.ts";

const ENV = { QUASO_HOSTNAME: "quaso.test", QUASO_API_KEY: "qso_key" };

const PROJECT = {
  "quaso.config.json": CONFIG,
  "src/locales/en/common.json": '{ "title": "Quest", "greeting": "Hi, {{name}}!" }\n',
  "src/locales/en/menus/main.json": '{ "play": "Play" }\n',
};

const ESTIMATE: JobEstimate = {
  strings: 6,
  words: 8,
  requests: 4,
  languages: [
    { language: "de", strings: 3, words: 4 },
    { language: "pl", strings: 3, words: 4 },
  ],
  files: [
    { file: "common.json", strings: 4, words: 6 },
    { file: "menus/main.json", strings: 2, words: 2 },
  ],
  work: { translate: 3, retranslate: 0, update: 2 },
  estimatedTokens: { input: 2400, output: 120 },
};

/** A server that creates job 7, then answers its progress from `states` in turn. */
function server(states: Partial<JobInfo>[]) {
  let polls = 0;
  const fetch = fakeFetch((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/api/v1/jobs") {
      return jsonResponse({ job: jobInfo({ status: "queued", ...states[0] }), estimate: null });
    }
    if (request.method === "GET" && path === "/api/v1/jobs/7") {
      polls++;
      return jsonResponse(jobInfo(states[Math.min(polls, states.length - 1)]));
    }
    return jsonResponse({ error: { code: "not_found", message: `No ${path}` } }, 404);
  });
  return fetch;
}

test("translate --dry-run prints the estimate and starts nothing", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = fakeFetch(() => jsonResponse({ job: null, estimate: ESTIMATE }));
    const run = await runCli(["translate", "--dry-run"], { cwd: dir, env: ENV, fetch });
    expect(run.code, run.stderr).toBe(0);
    const body: CreateJobRequest = await fetch.requests[0].json();
    expect(body).toStrictEqual({ languages: ["de", "pl"], dryRun: true });
    expect(run.stdout).toContain("Dry run: nothing was translated.");
    expect(run.stdout).toContain("de  3 strings  4 words");
    expect(run.stdout).toContain(
      "6 strings (8 words) in 4 requests: about 2,400 input and 120 output tokens.",
    );
    expect(run.stdout).toContain("Of these: 3 untranslated, 2 outdated to update.");
    expect(run.stderr).toContain("Estimating the translation of de, pl on https://quaso.test");

    const json = await runCli(["translate", "--dry-run", "--json"], { cwd: dir, env: ENV, fetch });
    const document = JSON.parse(json.stdout);
    expect(document.command).toBe("translate");
    expect(document.result).toStrictEqual({
      server: "https://quaso.test",
      dryRun: true,
      estimate: ESTIMATE,
    });
  });
});

test("translate sends the scope: languages, files, re-translation, instruction, model", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([{}]);
    const run = await runCli(
      [
        "translate",
        "--language",
        "PL",
        "--file",
        "src/locales/en/menus/main.json",
        "--file",
        "common.json",
        "--retranslate",
        "--instruction",
        "Use the informal you",
        "--model",
        "gemini-2.5-pro",
      ],
      { cwd: dir, env: ENV, fetch },
    );
    expect(run.code, run.stderr).toBe(0);
    const body: CreateJobRequest = await fetch.requests[0].json();
    expect(body).toStrictEqual({
      languages: ["pl"],
      files: ["common.json", "menus/main.json"],
      retranslate: true,
      instruction: "Use the informal you",
      model: "gemini-2.5-pro",
    });
  });
});

test("translate waits for the job, polling every 2 seconds, with progress on stderr", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([
      {
        status: "queued",
        progress: { total: 6, done: 0, translated: 0, proposed: 0, failed: 0, skipped: 0 },
      },
      {
        status: "running",
        progress: { total: 6, done: 2, translated: 2, proposed: 0, failed: 0, skipped: 0 },
      },
      {
        status: "running",
        progress: { total: 6, done: 2, translated: 2, proposed: 0, failed: 0, skipped: 0 },
      },
      {
        status: "done",
        progress: { total: 6, done: 6, translated: 6, proposed: 0, failed: 0, skipped: 0 },
      },
    ]);
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const run = await runCli(["translate"], { cwd: dir, env: ENV, fetch, sleep });
    expect(run.code, run.stderr).toBe(0);
    expect(waits).toStrictEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(fetch.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toStrictEqual([
      "POST /api/v1/jobs",
      "GET /api/v1/jobs/7",
      "GET /api/v1/jobs/7",
      "GET /api/v1/jobs/7",
    ]);
    expect(run.stderr).toContain("Translation job 7 is queued (6 strings).");
    expect(run.stderr).toContain("Translating: 2 of 6 (33%).");
    expect(run.stderr.split("Translating: 2 of 6").length, "unchanged progress once").toStrictEqual(
      2,
    );
    expect(run.stdout).toContain("Translation job 7 done: 6 translated (1,500 tokens).");
  });
});

test("translate exits 6 when strings failed, listing them with local paths", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([
      {
        status: "done",
        progress: { total: 6, done: 6, translated: 4, proposed: 0, failed: 2, skipped: 0 },
        failures: [
          {
            stringId: 3,
            file: "common.json",
            key: "greeting",
            language: "pl",
            reason: "Placeholder {{name}} is missing.",
          },
          {
            stringId: 4,
            file: "menus/main.json",
            key: "play",
            language: "de",
            reason: "At most 5 characters; this has 8.",
          },
        ],
      },
    ]);
    const run = await runCli(["translate"], { cwd: dir, env: ENV, fetch });
    expect(run.code).toBe(6);
    expect(run.stdout).toContain("4 translated, 2 failed");
    expect(run.stdout).toContain(
      "src/locales/pl/common.json › greeting (pl): placeholder {{name}} is missing",
    );
    expect(run.stdout).toContain(
      "src/locales/de/menus/main.json › play (de): at most 5 characters; this has 8",
    );
    const json = JSON.parse(
      (await runCli(["translate", "--json"], { cwd: dir, env: ENV, fetch })).stdout,
    );
    expect(json.exitCode).toBe(6);
    expect(json.ok).toBe(false);
    expect(json.result.failures[1]).toStrictEqual({
      file: "src/locales/de/menus/main.json",
      key: "play",
      language: "de",
      message: "At most 5 characters; this has 8.",
    });
    expect(json.result.job.progress.failed).toBe(2);
  });
});

test("translate exits 6 when the job failed or paused, with its reason", async () => {
  await withProject(PROJECT, async (dir) => {
    for (const [status, error] of [
      ["failed", "The job failed 5 times in a row: boom"],
      ["paused", "Monthly token budget reached"],
    ] as const) {
      const fetch = server([{ status, error }]);
      const run = await runCli(["translate"], { cwd: dir, env: ENV, fetch });
      expect(run.code, status).toBe(6);
      expect(run.stdout).toContain(`Translation job 7 ${status}`);
      expect(run.stdout).toContain(error.slice(1));
    }
  });
});

test("translate --no-wait starts the job and exits", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([{ status: "queued" }]);
    const run = await runCli(["translate", "--no-wait"], { cwd: dir, env: ENV, fetch });
    expect(run.code).toBe(0);
    expect(fetch.requests.length).toBe(1);
    expect(run.stdout).toContain("Translation job 7 is queued for 4 strings.");
    const json = JSON.parse(
      (await runCli(["translate", "--no-wait", "--json"], { cwd: dir, env: ENV, fetch })).stdout,
    );
    expect(json.result.waited).toBe(false);
    expect(json.result.job.id).toBe(7);
  });
});

test("translate: usage errors, and the instance's refusals with hints", async () => {
  await withProject(PROJECT, async (dir) => {
    const never = fakeFetch(() => jsonResponse({}));
    const source = await runCli(["translate", "--language", "en"], {
      cwd: dir,
      env: ENV,
      fetch: never,
    });
    expect(source.code).toBe(2);
    expect(source.stderr).toContain("en is the source language");
    const file = await runCli(["translate", "--file", "nope.json"], {
      cwd: dir,
      env: ENV,
      fetch: never,
    });
    expect(file.code).toBe(2);
    expect(never.requests.length).toBe(0);

    const off = fakeFetch(() =>
      jsonResponse(
        {
          error: {
            code: "llm_unavailable",
            message: "LLM translation is off: enter a Gemini API key in Settings.",
          },
        },
        503,
      ),
    );
    const unavailable = await runCli(["translate"], { cwd: dir, env: ENV, fetch: off });
    expect(unavailable.code).toBe(4);
    expect(unavailable.stderr).toContain(
      "LLM translation is off: enter a Gemini API key in Settings.",
    );
    expect(unavailable.stderr).toContain(
      "An administrator enters the Gemini API key in the instance's Settings → LLM translation.",
    );
    expect(off.requests.length, "not retried").toBe(1);

    const missing = fakeFetch(() =>
      jsonResponse(
        {
          error: { code: "bad_request", message: "The project has no language pl." },
        },
        400,
      ),
    );
    const language = await runCli(["translate"], { cwd: dir, env: ENV, fetch: missing });
    expect(language.code).toBe(2);
    expect(language.stderr).toContain("quaso upload adds the languages of quaso.config.json");

    const readOnly = fakeFetch(() =>
      jsonResponse({ error: { code: "forbidden", message: "You don't have permission." } }, 403),
    );
    expect((await runCli(["translate"], { cwd: dir, env: ENV, fetch: readOnly })).code).toBe(3);
  });
});

test("translate is in the help, with its options", async () => {
  const help = await runCli(["translate", "--help"]);
  expect(help.code).toBe(0);
  for (const option of [
    "--language",
    "--file",
    "--retranslate",
    "--instruction",
    "--model",
    "--no-wait",
    "--dry-run",
  ]) {
    expect(help.stdout).toContain(option);
  }
  assert((await runCli(["--help"])).stdout.includes("  translate"));
});

test("translate says when there was nothing to translate", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([
      {
        status: "done",
        progress: { total: 0, done: 0, translated: 0, proposed: 0, failed: 0, skipped: 0 },
      },
    ]);
    const run = await runCli(["translate"], { cwd: dir, env: ENV, fetch });
    expect(run.code).toBe(0);
    expect(fetch.requests.length, "a finished job needs no polling").toBe(1);
    expect(run.stdout).toContain("Nothing to translate");
  });
});
