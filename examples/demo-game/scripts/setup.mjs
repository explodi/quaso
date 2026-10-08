// SPDX-License-Identifier: MIT
// This local playground uses the same setup API and CLI as a real game project.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const credentials = existsSync(".env.quaso") ? parseEnv(readFileSync(".env.quaso", "utf8")) : {};

const hostname = "http://127.0.0.1:8000";
const email = "biscotte@example.test";
const password = credentials.QUASO_ADMIN_PASSWORD || randomBytes(12).toString("hex");
let apiKey = credentials.QUASO_API_KEY || "";
let cookie = "";

function saveCredentials() {
  writeFileSync(
    ".env.quaso",
    `QUASO_HOSTNAME=${hostname}\nQUASO_ADMIN_PASSWORD=${password}\nQUASO_API_KEY=${apiKey}\n`,
    { mode: 0o600 },
  );
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed. See its output above.`);
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${hostname}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: hostname, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${await response.text()}`);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  return response.json();
}

try {
  saveCredentials();
  console.log("Starting the local Quaso translation playground…");
  run("docker", ["compose", "up", "-d", "--wait", "--wait-timeout", "120"]);

  const session = await api("/auth/session");
  if (session.setupRequired) {
    await api("/auth/setup", "POST", {
      token: "quaso-quest-local-playground",
      email,
      password,
      displayName: "Biscotte",
      projectName: "Quaso Quest",
      sourceLanguage: "fr",
    });
    await api("/settings", "PATCH", {
      llm: { autoTranslate: false },
      description:
        "Un petit chat-croissant ramasse du beurre pour le pique-nique de Biscotte. Ton drôle, chaleureux et gourmand. Quaso et Biscotte sont des noms propres.",
    });
  } else {
    await api("/auth/signin", "POST", { email, password });
  }

  if (session.setupRequired || !apiKey) {
    const token = await api("/api-tokens", "POST", { name: "Quaso Quest CLI", scope: "upload" });
    apiKey = token.secret;
    saveCredentials();
  }

  run(process.execPath, ["node_modules/@quaso-i18n/cli/quaso.mjs", "upload"], {
    ...process.env,
    QUASO_HOSTNAME: hostname,
    QUASO_API_KEY: apiKey,
  });
  console.log(`\nQuaso Quest is ready to translate: ${hostname}\n`);
  console.log(`Sign in: ${email}\nPassword: ${password}\n`);
  console.log("Credentials are saved in .env.quaso (ignored by git).\n");
  console.log("Next: translate a string in Quaso, then run npm run quaso -- download.");
  console.log("Start the game with npm run dev and choose English or Deutsch.");
} catch (error) {
  console.error(`\nSetup did not finish: ${error.message}`);
  console.error(
    "Check that Docker is running and port 8000 is free, then run npm run quaso:setup again.",
  );
  process.exitCode = 1;
}
