// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import {
  checkConfigurationDocs,
  configurationVariables,
  missingConfigurationDocs,
} from "./check_config_docs.ts";

test("configuration variables include grouped secrets and ignore example prose", () => {
  const source = `// EXAMPLE_ONLY
  read.pair("OAUTH_ID", "OAUTH_SECRET", "id", "secret");
  read.together("EMAIL_FROM", "EMAIL_KEY");
  read.integer("PORT", 8000, 1, 65535); read.has("PORT");`;
  assertEquals(configurationVariables(source), [
    "EMAIL_FROM",
    "EMAIL_KEY",
    "OAUTH_ID",
    "OAUTH_SECRET",
    "PORT",
  ]);
  assertEquals(missingConfigurationDocs(source, "# PORT=8000", "`PORT`"), [
    "EMAIL_FROM is missing from deploy/.env.example",
    "EMAIL_FROM is missing from docs/configuration.md",
    "EMAIL_KEY is missing from deploy/.env.example",
    "EMAIL_KEY is missing from docs/configuration.md",
    "OAUTH_ID is missing from deploy/.env.example",
    "OAUTH_ID is missing from docs/configuration.md",
    "OAUTH_SECRET is missing from deploy/.env.example",
    "OAUTH_SECRET is missing from docs/configuration.md",
  ]);
});

test("all server configuration is documented", async () => {
  assertEquals(await checkConfigurationDocs(), []);
});
