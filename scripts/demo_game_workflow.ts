// SPDX-License-Identifier: MIT
/** Exercises the demo's setup and CLI against a temporary local server; Docker alone is stubbed. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { freePort } from "../packages/server/src/http/serve.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const demoSource = join(root, "examples/demo-game");
const directory = await mkdtemp(join(tmpdir(), "quaso-demo-workflow-"));
const demo = join(directory, "demo");
const port = await freePort();
const hostname = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  PUBLIC_URL: hostname,
  DATA_DIR: join(directory, "data"),
  SETUP_KEY: "quaso-quest-local-playground",
};
let cookie = "";
let apiKey = "";
let serverLog = "";
let server = spawn(process.execPath, [join(root, "packages/server/main.ts")], {
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", (chunk) => (serverLog += chunk));
let exited = new Promise<number | null>((resolve) => server.once("exit", resolve));

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${hostname}/api/v1${path}`, {
    method,
    headers: { Origin: hostname, Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, await response.clone().text());
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  return response.json();
}

async function run(args: string[], environment = process.env, expectedCode = 0) {
  const process_ = spawn(process.execPath, args, {
    cwd: demo,
    env: environment,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  process_.stdout.on("data", (chunk) => (output += chunk));
  process_.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    process_.once("error", reject);
    process_.once("exit", resolve);
  });
  assert.equal(code, expectedCode, output);
  return output;
}

function cli(args: string[], expectedCode = 0) {
  return run(
    [join(demo, "node_modules/@quaso-i18n/cli/quaso.mjs"), ...args],
    { ...process.env, QUASO_HOSTNAME: hostname, QUASO_API_KEY: apiKey },
    expectedCode,
  );
}

async function writeJson(path: string, value: unknown) {
  await writeFile(join(demo, path), JSON.stringify(value, null, 2));
}

async function waitForServer() {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`${hostname}/healthz`)).ok;
    } catch {
      /* Still starting. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(ready, serverLog);
}

try {
  await waitForServer();
  await mkdir(join(demo, "scripts"), { recursive: true });
  await cp(join(demoSource, "src"), join(demo, "src"), { recursive: true });
  await cp(join(demoSource, "quaso.config.json"), join(demo, "quaso.config.json"));
  await symlink(join(demoSource, "node_modules"), join(demo, "node_modules"), "dir");
  // Only redirect the playground's fixed loopback address; its actual setup code and CLI run.
  const setupSource = await readFile(join(demoSource, "scripts/setup.mjs"), "utf8");
  assert(setupSource.includes('const hostname = "http://127.0.0.1:8000";'));
  await writeFile(
    join(demo, "scripts/setup.mjs"),
    setupSource.replace("http://127.0.0.1:8000", hostname),
  );
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "bin/docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const setup = () =>
    run([join(demo, "scripts/setup.mjs")], {
      ...process.env,
      PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    });

  await setup();
  const credentials = parseEnv(await readFile(join(demo, ".env.quaso"), "utf8"));
  assert(credentials.QUASO_API_KEY);
  assert(credentials.QUASO_ADMIN_PASSWORD);
  apiKey = credentials.QUASO_API_KEY;
  await api("/auth/signin", "POST", {
    email: "biscotte@example.test",
    password: credentials.QUASO_ADMIN_PASSWORD,
  });
  assert.equal((await api("/settings")).settings.syntax.icu, true);
  await cli(["download"]);
  const status = await api("/status");
  const spanish = status.languages.find((language: { tag: string }) => language.tag === "es");
  assert.equal(spanish.untranslated, 0);
  assert.equal(spanish.qa, 0);
  const repeated = await setup();
  assert.match(repeated, /Nothing changed/);
  assert.match(repeated, /0 imported/);
  console.log("Fresh setup and repeated setup: ICU enabled, Spanish complete, no QA refusals.");

  // Older playgrounds keep their reviewed translations through conversion and the new upload.
  await api("/settings", "PATCH", { syntax: { prefix: "{{", suffix: "}}", icu: false } });
  await writeJson("src/locales/fr/game.json", { score: "{{score}} points" });
  await writeJson("src/locales/en/game.json", { score: "{{score}} points earned" });
  const config = JSON.parse(await readFile(join(demo, "quaso.config.json"), "utf8"));
  await writeJson("quaso.config.json", { ...config, arguments: [] });
  await cli(["upload", "--file", "game.json"]);
  await cli(["import", "--as", "blue", "--language", "en", "--file", "game.json"]);
  await cp(join(demoSource, "src/locales/fr"), join(demo, "src/locales/fr"), { recursive: true });
  await writeJson("quaso.config.json", config);
  await setup();
  await cli(["download", "--language", "en", "--overwrite-local"]);
  const converted = JSON.parse(await readFile(join(demo, "src/locales/en/game.json"), "utf8"));
  assert.equal(converted.score, "{score} points earned");
  console.log("Existing i18next playground: reviewed English translation survives ICU migration.");

  // The source need not use gender: declaring it lets Spanish introduce agreement itself.
  const source = {
    title: "Mayor {name}",
    report: "{name} opened {count, plural, one {# park} other {# parks}}.",
  };
  const translation = {
    title:
      "{gender, select, female {La alcaldesa {name}} male {El alcalde {name}} other {La persona en la alcaldía: {name}}}",
    report:
      "{gender, select, female {La alcaldesa {name} abrió {count, plural, one {# parque} many {# parques} other {# parques}}.} male {El alcalde {name} abrió {count, plural, one {# parque} many {# parques} other {# parques}}.} other {La persona en la alcaldía, {name}, abrió {count, plural, one {# parque} many {# parques} other {# parques}}.}}",
  };
  server.kill("SIGTERM");
  assert.equal(await exited, 0, serverLog);
  env.DATA_DIR = join(directory, "mayor-data");
  server = spawn(process.execPath, [join(root, "packages/server/main.ts")], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => (serverLog += chunk));
  exited = new Promise<number | null>((resolve) => server.once("exit", resolve));
  await waitForServer();
  cookie = "";
  await api("/auth/setup", "POST", {
    token: "quaso-quest-local-playground",
    email: "mayor@example.test",
    password: "test-mayor-password",
    displayName: "Mayor",
    projectName: "Mayoral newspaper",
    sourceLanguage: "en",
  });
  await api("/settings", "PATCH", {
    syntax: { prefix: "{{", suffix: "}}", icu: true },
    llm: { autoTranslate: false },
  });
  apiKey = (await api("/api-tokens", "POST", { name: "Mayoral CLI", scope: "upload" })).secret;
  await writeJson("quaso.config.json", {
    sourceLanguage: "en",
    languages: ["es"],
    files: [{ source: "mayor.json", translation: "mayor.{lang}.json" }],
    arguments: [
      {
        name: "gender",
        cases: ["female", "male"],
        description: "The mayor's pronouns: female she/her, male he/him, other neutral wording.",
      },
    ],
  });
  await writeJson("mayor.json", source);
  await writeJson("mayor.es.json", translation);
  await cli(["upload", "--import-translations", "es"]);
  await rm(join(demo, "mayor.es.json"));
  await cli(["download", "--language", "es"]);
  const downloaded = JSON.parse(await readFile(join(demo, "mayor.es.json"), "utf8"));
  assert.deepEqual(downloaded, translation);

  await writeJson("mayor.es.json", {
    title: "{gender, select, female {La alcaldesa {name}} male {El alcalde {name}}}",
  });
  const refused = await cli(["import", "--as", "blue", "--language", "es", "--overwrite"], 6);
  assert.match(refused, /other/);
  await writeJson("mayor.es.json", {
    title:
      "{gender, select, female {La alcaldesa {name}} male {El alcalde {name}} other {La persona en la alcaldía}}",
  });
  const missingName = await cli(["import", "--as", "blue", "--language", "es", "--overwrite"], 6);
  assert.match(missingName, /name/);
  await cli(["download", "--language", "es", "--overwrite-local"]);
  const preserved = JSON.parse(await readFile(join(demo, "mayor.es.json"), "utf8"));
  assert.deepEqual(preserved, translation);
  console.log(
    "Declared gender: complete Spanish selects and nested plurals round-trip; missing other or a neutral-branch name is refused.",
  );
} finally {
  server.kill("SIGTERM");
  const deadline = setTimeout(() => server.kill("SIGKILL"), 5000);
  const code = await exited;
  clearTimeout(deadline);
  await rm(directory, { recursive: true, force: true });
  assert.equal(code, 0, serverLog);
}
