// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
/**
 * The LLM routes with the real service and the fake translator, through `createApp`:
 * jobs, their progress and cancelling, usage and models, and who may call them.
 */
import type { CreateJobResult, JobInfo, JobsResult, UsageResult } from "@quaso/core";
import { createFakeTranslator, type Service, SYSTEM } from "@quaso/service";
import type { App } from "../app.ts";
import { realService } from "../testing/real_service.ts";
import { call, testApp } from "../testing/helpers.ts";

interface Setup {
  app: App;
  service: Service;
  upload: string;
  read: string;
}

async function withLlm(fn: (setup: Setup) => Promise<void>, provider = true): Promise<void> {
  const real = await realService(provider ? { provider: createFakeTranslator() } : {});
  try {
    const upload = await real.service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
    const read = await real.service.createApiToken(SYSTEM, { name: "Read", scope: "read" });
    await real.service.upload(SYSTEM, {
      files: [
        {
          path: "common.json",
          repoPath: "common.json",
          content: '{ "play": "Play", "quit": "Quit" }',
        },
      ],
      languages: ["de", "pl"],
    });
    const { app } = testApp(real.service);
    await fn({ app, service: real.service, upload: upload.secret, read: read.secret });
  } finally {
    real.close();
  }
}

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toStrictEqual(status);
  return body;
}

test("jobs routes: dry run, create, follow, list, and cancel", async () => {
  await withLlm(async ({ app, service, upload }) => {
    // The upload's automatic job translates everything first.
    await service.alarm();
    const dry = await json<CreateJobResult>(
      call(app, "/api/v1/jobs", {
        method: "POST",
        key: upload,
        json: { dryRun: true, languages: ["de"], retranslate: true },
      }),
    );
    expect(dry.job).toBe(null);
    expect(dry.estimate?.languages).toStrictEqual([{ language: "de", strings: 2, words: 2 }]);

    const created = await json<CreateJobResult>(
      call(app, "/api/v1/jobs", {
        method: "POST",
        key: upload,
        json: { languages: ["de"], retranslate: true, instruction: "Be brief." },
      }),
    );
    assert(created.job !== null);
    expect(created.job.status).toBe("queued");
    const id = created.job.id;
    const listed = await json<JobsResult>(call(app, "/api/v1/jobs", { key: upload }));
    expect(listed.jobs.map((job) => job.id).includes(id)).toBe(true);

    const cancelled = await json<JobInfo>(
      call(app, `/api/v1/jobs/${id}`, { method: "DELETE", key: upload }),
    );
    expect(cancelled.status).toBe("cancelled");

    const second = await json<CreateJobResult>(
      call(app, "/api/v1/jobs", {
        method: "POST",
        key: upload,
        json: { languages: ["pl"], retranslate: true },
      }),
    );
    await service.alarm();
    const done = await json<JobInfo>(call(app, `/api/v1/jobs/${second.job!.id}`, { key: upload }));
    expect(done.status).toBe("done");
    expect(done.progress.translated).toBe(2);
    const conflict = await json<{ error: { code: string } }>(
      call(app, `/api/v1/jobs/${second.job!.id}`, { method: "DELETE", key: upload }),
      409,
    );
    expect(conflict.error.code).toBe("conflict");
    const missing = await json<{ error: { code: string } }>(
      call(app, "/api/v1/jobs/999", { key: upload }),
      404,
    );
    expect(missing.error.code).toBe("not_found");
  });
});

test("jobs routes: usage and models", async () => {
  await withLlm(async ({ app, service, upload }) => {
    await service.createJob(SYSTEM, {});
    await service.alarm();
    const usage = await json<UsageResult>(call(app, "/api/v1/usage?period=month", { key: upload }));
    expect(usage.period).toBe("month");
    expect(usage.rows.length).toBe(12);
    assert(usage.rows[11].requests > 0);
    expect(usage.budget.monthlyTokens).toBe(null);
    const bad = await json<{ error: { code: string } }>(
      call(app, "/api/v1/usage?period=week", { key: upload }),
      400,
    );
    expect(bad.error.code).toBe("validation_failed");
    expect(await json(call(app, "/api/v1/models", { key: upload }))).toStrictEqual({
      models: ["fake-translator"],
    });
  });
});

test("jobs routes: active query returns queued jobs and removes completed jobs", async () => {
  await withLlm(async ({ app, service, upload }) => {
    const queued = await json<JobsResult>(call(app, "/api/v1/jobs?active=true", { key: upload }));
    expect(queued.jobs.length).toBe(1);
    expect(queued.jobs[0].status).toBe("queued");
    await service.alarm();
    const active = await json<JobsResult>(call(app, "/api/v1/jobs?active=true", { key: upload }));
    expect(active.jobs).toStrictEqual([]);
    const all = await json<JobsResult>(call(app, "/api/v1/jobs?active=false", { key: upload }));
    expect(all.jobs[0].status).toBe("done");
    const bad = await json<{ error: { code: string } }>(
      call(app, "/api/v1/jobs?active=yes", { key: upload }),
      400,
    );
    expect(bad.error.code).toBe("validation_failed");
  });
});

test("jobs routes: anonymous callers and read keys are refused", async () => {
  await withLlm(async ({ app, read }) => {
    for (const [path, method] of [
      ["/jobs", "POST"],
      ["/jobs", "GET"],
      ["/usage?period=day", "GET"],
      ["/models", "GET"],
    ]) {
      const init = method === "POST" ? { method, json: {} } : { method };
      const anonymous = await json<{ error: { code: string } }>(
        call(app, `/api/v1${path}`, init),
        401,
      );
      expect(anonymous.error.code, path).toBe("unauthorized");
      const denied = await json<{ error: { code: string } }>(
        call(app, `/api/v1${path}`, { ...init, key: read }),
        403,
      );
      expect(denied.error.code, path).toBe("forbidden");
    }
  });
});

test("jobs routes: without a provider, 503 with the reason", async () => {
  await withLlm(async ({ app, upload }) => {
    const off = await json<{ error: { code: string; message: string } }>(
      call(app, "/api/v1/jobs", { method: "POST", key: upload, json: {} }),
      503,
    );
    expect(off.error).toStrictEqual({
      code: "llm_unavailable",
      message: "LLM translation is off: enter a Gemini API key in Settings.",
    });
    expect(await json(call(app, "/api/v1/models", { key: upload }))).toStrictEqual({ models: [] });
  }, false);
});
