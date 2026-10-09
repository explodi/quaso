// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
    assertEquals(run.code, 0, run.stderr);
    const body: CreateJobRequest = await fetch.requests[0].json();
    assertEquals(body, { languages: ["de", "pl"], dryRun: true });
    assertStringIncludes(run.stdout, "Dry run: nothing was translated.");
    assertStringIncludes(run.stdout, "de  3 strings  4 words");
    assertStringIncludes(
      run.stdout,
      "6 strings (8 words) in 4 requests: about 2,400 input and 120 output tokens.",
    );
    assertStringIncludes(run.stderr, "Estimating the translation of de, pl on https://quaso.test");

    const json = await runCli(["translate", "--dry-run", "--json"], { cwd: dir, env: ENV, fetch });
    const document = JSON.parse(json.stdout);
    assertEquals(document.command, "translate");
    assertEquals(document.result, {
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
    assertEquals(run.code, 0, run.stderr);
    const body: CreateJobRequest = await fetch.requests[0].json();
    assertEquals(body, {
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
    assertEquals(run.code, 0, run.stderr);
    assertEquals(waits, [POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    assertEquals(
      fetch.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
      ["POST /api/v1/jobs", "GET /api/v1/jobs/7", "GET /api/v1/jobs/7", "GET /api/v1/jobs/7"],
    );
    assertStringIncludes(run.stderr, "Translation job 7 is queued (6 strings).");
    assertStringIncludes(run.stderr, "Translating: 2 of 6 (33%).");
    assertEquals(run.stderr.split("Translating: 2 of 6").length, 2, "unchanged progress once");
    assertStringIncludes(run.stdout, "Translation job 7 done: 6 translated (1,500 tokens).");
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
    assertEquals(run.code, 6);
    assertStringIncludes(run.stdout, "4 translated, 2 failed");
    assertStringIncludes(
      run.stdout,
      "src/locales/pl/common.json › greeting (pl): placeholder {{name}} is missing",
    );
    assertStringIncludes(
      run.stdout,
      "src/locales/de/menus/main.json › play (de): at most 5 characters; this has 8",
    );
    const json = JSON.parse(
      (await runCli(["translate", "--json"], { cwd: dir, env: ENV, fetch })).stdout,
    );
    assertEquals(json.exitCode, 6);
    assertEquals(json.ok, false);
    assertEquals(json.result.failures[1], {
      file: "src/locales/de/menus/main.json",
      key: "play",
      language: "de",
      message: "At most 5 characters; this has 8.",
    });
    assertEquals(json.result.job.progress.failed, 2);
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
      assertEquals(run.code, 6, status);
      assertStringIncludes(run.stdout, `Translation job 7 ${status}`);
      assertStringIncludes(run.stdout, error.slice(1));
    }
  });
});

test("translate --no-wait starts the job and exits", async () => {
  await withProject(PROJECT, async (dir) => {
    const fetch = server([{ status: "queued" }]);
    const run = await runCli(["translate", "--no-wait"], { cwd: dir, env: ENV, fetch });
    assertEquals(run.code, 0);
    assertEquals(fetch.requests.length, 1);
    assertStringIncludes(run.stdout, "Translation job 7 is queued for 4 strings.");
    const json = JSON.parse(
      (await runCli(["translate", "--no-wait", "--json"], { cwd: dir, env: ENV, fetch })).stdout,
    );
    assertEquals(json.result.waited, false);
    assertEquals(json.result.job.id, 7);
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
    assertEquals(source.code, 2);
    assertStringIncludes(source.stderr, "en is the source language");
    const file = await runCli(["translate", "--file", "nope.json"], {
      cwd: dir,
      env: ENV,
      fetch: never,
    });
    assertEquals(file.code, 2);
    assertEquals(never.requests.length, 0);

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
    assertEquals(unavailable.code, 4);
    assertStringIncludes(
      unavailable.stderr,
      "LLM translation is off: enter a Gemini API key in Settings.",
    );
    assertStringIncludes(
      unavailable.stderr,
      "An administrator enters the Gemini API key in the instance's Settings → LLM translation.",
    );
    assertEquals(off.requests.length, 1, "not retried");

    const missing = fakeFetch(() =>
      jsonResponse(
        {
          error: { code: "bad_request", message: "The project has no language pl." },
        },
        400,
      ),
    );
    const language = await runCli(["translate"], { cwd: dir, env: ENV, fetch: missing });
    assertEquals(language.code, 2);
    assertStringIncludes(language.stderr, "quaso upload adds the languages of quaso.config.json");

    const readOnly = fakeFetch(() =>
      jsonResponse({ error: { code: "forbidden", message: "You don't have permission." } }, 403),
    );
    assertEquals((await runCli(["translate"], { cwd: dir, env: ENV, fetch: readOnly })).code, 3);
  });
});

test("translate is in the help, with its options", async () => {
  const help = await runCli(["translate", "--help"]);
  assertEquals(help.code, 0);
  for (const option of [
    "--language",
    "--file",
    "--retranslate",
    "--instruction",
    "--model",
    "--no-wait",
    "--dry-run",
  ]) {
    assertStringIncludes(help.stdout, option);
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
    assertEquals(run.code, 0);
    assertEquals(fetch.requests.length, 1, "a finished job needs no polling");
    assertStringIncludes(run.stdout, "Nothing to translate");
  });
});
