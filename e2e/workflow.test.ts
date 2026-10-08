// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { ANONYMOUS, SYSTEM, createFakeTranslator, type ProviderRequest } from "@quaso/service";
import { startServer, openBrowser } from "./_setup.ts";
import { runWorkflow } from "../acceptance/workflow.ts";

const EMAIL = "workflow@example.com";
const PASSWORD = "a long workflow test password";

test(
  "the nine-step Beta 2 workflow uses the CLI, browser and proofread Spanish in every LLM prompt",
  { timeout: 180_000 },
  async () => {
    const requests: ProviderRequest[] = [];
    const fake = createFakeTranslator({ delayMs: 150 });
    const server = await startServer({
      serviceOptions: {
        llmConcurrency: 1,
        provider: {
          ...fake,
          async translate(request) {
            requests.push(request);
            return await fake.translate(request);
          },
        },
      },
      async prepare(service) {
        const setup = await service.ensureSetupToken(SYSTEM, {});
        await service.completeSetup(ANONYMOUS, {
          token: setup.token!,
          email: EMAIL,
          password: PASSWORD,
          displayName: "Workflow Owner",
          projectName: "Workflow fixture",
        });
      },
    });
    const browser = await openBrowser();
    let stopped = false;
    const alarms = (async () => {
      while (!stopped) {
        await server.service.alarm();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    try {
      const result = await runWorkflow({
        url: server.url,
        browser,
        email: EMAIL,
        password: PASSWORD,
        step: console.log,
      });
      assertEquals(result.job.progress.total, 54);
      const tokens = await server.service.listApiTokens(SYSTEM, {});
      assertEquals(
        tokens.tokens.filter((token) => token.revokedAt === null).map((token) => token.name),
        ["Browser tests"],
      );
      assertEquals(requests.length, 45);
      for (const request of requests) {
        assertStringIncludes(request.prompt, '"language":"es"');
        assertStringIncludes(request.prompt, '"proofread":true');
        assertStringIncludes(request.prompt, "[es]");
      }
    } finally {
      stopped = true;
      try {
        await alarms;
      } finally {
        try {
          await browser.close();
        } finally {
          await server.close();
        }
      }
    }
  },
);
