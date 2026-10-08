// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import * as fs from "node:fs/promises";
import { test } from "node:test";
/**
 * The server with Cloudflare storage (`SERVICES_URL`), against an in-process stand-in for
 * the Worker: the real service behind `handleServiceRequest`, as the Durable Object runs it.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import {
  DATABASE_VERSION,
  handleServiceRequest,
  SERVICE_METHODS,
  type ServiceApi,
  ServiceError,
  SYSTEM,
} from "@quaso/service";
import { createApp } from "../app.ts";
import { loadConfig, secureServicesUrl } from "../config.ts";
import { demoDir, readProjectFiles } from "../dev_seed.ts";
import { call, memoryLogger, testConfig } from "../testing/helpers.ts";
import { realService } from "../testing/real_service.ts";
import { connectRemoteService, RemoteSetupError } from "./remote.ts";

const TOKEN = "internal-token-for-the-tests-0123456789";
const REMOTE_ENV = {
  SERVICES_URL: "https://quaso.test/internal",
  SERVICE_TOKEN: TOKEN,
  SECRET_KEY: "k".repeat(64),
};

/** A fetch that answers like the Worker's internal API, from `service`. */
function workerStub(service: ServiceApi, token: string | null = TOKEN): Fetch {
  return (input, init) => {
    const request = new Request(input, init);
    assertEquals(new URL(request.url).origin, "https://quaso.test");
    return handleServiceRequest(request, service, { token });
  };
}

async function demoUpload() {
  const { config, sources } = await readProjectFiles(demoDir());
  return { files: sources, sourceLanguage: config.sourceLanguage, languages: config.languages };
}

test("remote: the API works through the internal API, as with local storage", async () => {
  const real = await realService();
  try {
    const log = memoryLogger();
    const config = testConfig(REMOTE_ENV);
    const service = await connectRemoteService(config, log, { fetch: workerStub(real.service) });
    const app = createApp({ config, service, log, version: "9.9.9", storage: "cloudflare" });
    assertEquals(
      log.lines.find((line) => line.msg === "Using Cloudflare storage")?.servicesUrl,
      "https://quaso.test/internal",
    );

    const health = await call(app, "/healthz");
    assertEquals(await health.json(), {
      ok: true,
      version: "9.9.9",
      storage: "cloudflare",
      schemaVersion: DATABASE_VERSION,
      revision: 0,
    });

    const key = await service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
    const body = await demoUpload();
    const anonymous = await call(app, "/api/v1/sources", { method: "POST", json: body });
    assertEquals(anonymous.status, 401);
    assertEquals((await anonymous.json()).error.code, "unauthorized");

    const uploaded = await call(app, "/api/v1/sources", {
      method: "POST",
      json: body,
      key: key.secret,
    });
    assertEquals(uploaded.status, 200);
    assertEquals((await uploaded.json()).files.length, body.files.length);

    const exported = await call(app, "/api/v1/export?languages=pl", { key: key.secret });
    assertEquals(exported.status, 200);
    const files = (await exported.json()).files as { path: string; language: string }[];
    assertEquals(
      files.map((file) => file.language),
      body.files.map(() => "pl"),
    );

    const status = await call(app, "/api/v1/status", { key: key.secret });
    assertEquals(status.status, 200);
    assertEquals((await status.json()).languages.length, body.languages.length);

    // The same answer as the service gives directly.
    const project = await call(app, "/api/v1/project");
    assertEquals(
      await project.json(),
      JSON.parse(JSON.stringify(await real.service.getProject({ type: "anonymous" }, {}))),
    );

    // Keys are checked in the Durable Object: an unknown one is refused.
    const unknown = await call(app, "/api/v1/status", { key: `${key.secret}x` });
    assertEquals(unknown.status, 401);
  } finally {
    real.close();
  }
});

test("remote: a refused token, or an internal API that is off, stops the server", async () => {
  const real = await realService();
  try {
    const cases: [string | null, string][] = [
      ["another-token", "SERVICE_TOKEN must be the same"],
      [null, "is SERVICE_TOKEN set on the Worker"],
    ];
    for (const [token, words] of cases) {
      const error = await assertRejects(
        () =>
          connectRemoteService(testConfig(REMOTE_ENV), memoryLogger(), {
            fetch: workerStub(real.service, token),
          }),
        RemoteSetupError,
      );
      assertStringIncludes(
        error.message,
        "Cloudflare storage at https://quaso.test/internal refused the server",
      );
      assertStringIncludes(error.message, words);
    }
  } finally {
    real.close();
  }
});

test("remote: when the Worker doesn't answer, the server starts, and says so", async () => {
  const log = memoryLogger();
  const config = testConfig(REMOTE_ENV);
  let calls = 0;
  const down: Fetch = () => {
    calls++;
    return Promise.reject(new TypeError("error sending request: connection refused"));
  };
  const service = await connectRemoteService(config, log, { fetch: down, retryDelayMs: 1 });
  assertEquals(calls, 3, "getHealth is tried three times");
  assert(
    log.lines.some(
      (line) => line.msg === "Cloudflare storage isn't answering yet; starting anyway",
    ),
  );
  const app = createApp({ config, service, log, storage: "cloudflare" });
  const health = await call(app, "/healthz");
  assertEquals(health.status, 503);
  assertEquals((await health.json()).storage, "cloudflare");
  const project = await call(app, "/api/v1/project");
  assertEquals(project.status, 503);
  assertEquals((await project.json()).error, {
    code: "unavailable",
    message: "The service isn't available right now. Try again in a moment.",
  });
});

test("remote: a 503 from the Worker at start is 'not answering yet'", async () => {
  // What the Worker answers while the Durable Object is reset by a deploy.
  const log = memoryLogger();
  let calls = 0;
  const resetting: Fetch = () => {
    calls++;
    return Promise.resolve(
      Response.json(
        { error: { code: "unavailable", message: "Try again in a moment." } },
        {
          status: 503,
          headers: { "Retry-After": "5" },
        },
      ),
    );
  };
  await connectRemoteService(testConfig(REMOTE_ENV), log, { fetch: resetting, retryDelayMs: 1 });
  assertEquals(calls, 3);
  assert(log.lines.some((line) => String(line.msg).includes("starting anyway")));
});

test("remote: a problem the service reports at start stops the server with it", async () => {
  // The Durable Object answers every call with its settings problem, as a service error.
  const problem = "SECRET_KEY must be at least 32 characters long (openssl rand -hex 32).";
  const broken = Object.fromEntries(
    SERVICE_METHODS.map((method) => [
      method,
      () => Promise.reject(new ServiceError("unavailable", problem)),
    ]),
  ) as unknown as ServiceApi;
  let calls = 0;
  const stub = workerStub(broken);
  const error = await assertRejects(
    () =>
      connectRemoteService(testConfig(REMOTE_ENV), memoryLogger(), {
        fetch: (input, init) => {
          calls++;
          return stub(input, init);
        },
        retryDelayMs: 1,
      }),
    RemoteSetupError,
  );
  assertEquals(calls, 1, "a service error isn't tried again");
  assertStringIncludes(error.message, "Cloudflare storage at https://quaso.test/internal");
  assertStringIncludes(error.message, problem);
});

test("remote: one-off commands need an answer", async () => {
  const log = memoryLogger();
  const down: Fetch = () =>
    Promise.reject(new TypeError("error sending request: connection refused"));
  const error = await assertRejects(
    () =>
      connectRemoteService(testConfig(REMOTE_ENV), log, {
        fetch: down,
        retryDelayMs: 1,
        requireAnswer: true,
      }),
    RemoteSetupError,
  );
  assertStringIncludes(error.message, "isn't answering: TypeError: error sending request");
  assert(!log.lines.some((line) => String(line.msg).includes("starting anyway")));
});

const MAIN = fromFileUrl(new URL("../../main.ts", import.meta.url));

test(
  "remote: quaso serve and token create with SERVICES_URL keep nothing on disk",
  { skip: process.platform === "win32" },
  async () => {
    const real = await realService();
    const worker = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) =>
      handleServiceRequest(request, real.service, { token: TOKEN }),
    );
    const dir = await Deno.makeTempDir();
    try {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = String(listener.addr.port);
      listener.close();
      const env = {
        ...REMOTE_ENV,
        SERVICES_URL: `http://127.0.0.1:${worker.addr.port}/internal`,
        DATA_DIR: join(dir, "data"),
        WEB_DIR: join(dir, "no-website"),
        PORT: port,
        LOG_LEVEL: "info",
      };
      const command = (args: string[]) =>
        new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", MAIN, ...args],
          env,
          cwd: dir,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        });

      const server = command(["serve"]).spawn();
      try {
        let health: Record<string, unknown> | null = null;
        for (let i = 0; i < 100 && health === null; i++) {
          try {
            health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
          } catch {
            await new Promise((done) => setTimeout(done, 100));
          }
        }
        assertEquals(health?.storage, "cloudflare");
        assertEquals(health?.ok, true);

        // With Cloudflare storage, token create works while the server runs.
        const created = await command([
          "token",
          "create",
          "--name",
          "CI",
          "--scope",
          "upload",
        ]).output();
        const secret = new TextDecoder().decode(created.stdout).trim();
        assertEquals(created.code, 0, new TextDecoder().decode(created.stderr));
        assertMatch(secret, /^qso_/);
        const uploaded = await fetch(`http://127.0.0.1:${port}/api/v1/sources`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          body: JSON.stringify(await demoUpload()),
        });
        assertEquals(uploaded.status, 200);
        await uploaded.body?.cancel();
        assertEquals((await real.service.getHealth(SYSTEM, {})).revision, 1);
      } finally {
        server.kill("SIGTERM");
      }
      const { code, stdout } = await server.output();
      assertEquals(code, 0);
      // JSON lines, and the setup link's plain lines (no administrator here).
      const messages = new TextDecoder()
        .decode(stdout)
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line).msg);
      assert(messages.includes("Using Cloudflare storage"), messages.join(", "));
      assertEquals(messages.slice(-2), ["Shutting down", "Stopped"]);
      // No data folder, lock or snapshots.
      assertEquals(
        await fs.stat(join(dir, "data")).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      await worker.shutdown();
      real.close();
      await fs.rm(dir, { recursive: true });
    }
  },
);

test(
  "remote: token create explains in one line when Cloudflare storage fails",
  { skip: process.platform === "win32" },
  async () => {
    // getHealth answers; createApiToken gets the Worker's 503, as during a deploy.
    const worker = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
      if (new URL(request.url).pathname.endsWith("/getHealth")) {
        return Response.json({ result: { ok: true, schemaVersion: 1, revision: 0 } });
      }
      return Response.json(
        {
          error: { code: "unavailable", message: "Quaso's storage isn't available right now." },
        },
        { status: 503 },
      );
    });
    const dir = await Deno.makeTempDir();
    const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const closedPort = closed.addr.port;
    closed.close();
    try {
      const create = async (servicesUrl: string) => {
        const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", MAIN, "token", "create", "--name", "CI"].concat([
            "--scope",
            "upload",
          ]),
          env: { ...REMOTE_ENV, SERVICES_URL: servicesUrl, DATA_DIR: join(dir, "data") },
          cwd: dir,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const text = new TextDecoder().decode(stderr);
        assertEquals(new TextDecoder().decode(stdout), "", "no secret");
        assert(!text.includes("Uncaught"), text);
        assert(!text.includes("starting anyway"), text);
        return { code, stderr: text };
      };

      const down = await create(`http://127.0.0.1:${closedPort}/internal`);
      assertEquals(down.code, 1);
      assertStringIncludes(
        down.stderr,
        `Cloudflare storage at http://127.0.0.1:${closedPort}/internal isn't answering`,
      );

      const failing = await create(`http://127.0.0.1:${worker.addr.port}/internal`);
      assertEquals(failing.code, 1);
      assertStringIncludes(
        failing.stderr,
        "Couldn't create the API key: The service isn't available right now. " +
          "Try again in a moment. (unavailable: Quaso's storage isn't available",
      );
    } finally {
      await worker.shutdown();
      await fs.rm(dir, { recursive: true });
    }
  },
);

test("remote: SERVICES_URL must keep the token off the network in the clear", () => {
  for (const url of [
    "https://translate.yourgame.com/internal",
    "http://127.0.0.1:8787/internal",
    "http://localhost:8787/internal",
    "http://host.docker.internal:8787/internal",
  ]) {
    assert(secureServicesUrl(url), url);
    assert(loadConfig({ ...REMOTE_ENV, SERVICES_URL: url }, { cwd: "/" }).ok, url);
  }
  for (const url of ["http://translate.yourgame.com/internal", "http://10.0.0.5:8787/internal"]) {
    assert(!secureServicesUrl(url), url);
    const result = loadConfig({ ...REMOTE_ENV, SERVICES_URL: url }, { cwd: "/" });
    assert(!result.ok);
    assertStringIncludes(result.problems.join("\n"), "SERVICES_URL must use https");
  }
});
