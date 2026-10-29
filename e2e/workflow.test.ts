// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
      expect(result.job.progress.total).toBe(54);
      const tokens = await server.service.listApiTokens(SYSTEM, {});
      expect(
        tokens.tokens.filter((token) => token.revokedAt === null).map((token) => token.name),
      ).toStrictEqual(["Browser tests"]);
      expect(requests.length).toBe(45);
      for (const request of requests) {
        expect(request.prompt).toContain('"language":"es"');
        expect(request.prompt).toContain('"proofread":true');
        expect(request.prompt).toContain("[es]");
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
