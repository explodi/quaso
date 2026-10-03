// SPDX-License-Identifier: MIT
/** Run the Beta 2 workflow against a dedicated disposable instance. */
import { openBrowser } from "../e2e/_setup.ts";
import { runWorkflow } from "../acceptance/workflow.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--url") {
  throw new Error("Usage: bun run workflow --url URL (dedicated empty instance with an LLM stub)");
}
const url = new URL(args[1]!);
const supportedProtocol = url.protocol === "http:" || url.protocol === "https:";
const plainOrigin =
  url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
if (!supportedProtocol || !plainOrigin)
  throw new Error("Use an HTTP(S) instance origin without credentials or a path");
const browser = await openBrowser();
try {
  const id = crypto.randomUUID();
  const result = await runWorkflow({
    url: url.origin,
    browser,
    email: process.env["QUASO_ADMIN_EMAIL"] ?? `workflow-${id}@example.com`,
    password: process.env["QUASO_ADMIN_PASSWORD"] ?? `Workflow-${id}`,
    setupToken: process.env["QUASO_SETUP_KEY"],
    step: console.log,
  });
  console.log(
    `Workflow passes: job ${result.job.id}, ${result.job.progress.translated} translations`,
  );
} finally {
  await browser.close();
}
