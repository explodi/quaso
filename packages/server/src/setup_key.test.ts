// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { ANONYMOUS, SYSTEM } from "@quaso/service";
import { configureSetupKey } from "./setup_key.ts";
import { memoryLogger, testConfig } from "./testing/helpers.ts";
import { realService } from "./testing/real_service.ts";

const KEY = "operator-only-setup-key";

test("setup key: missing and short configuration leaves setup unavailable", async () => {
  const { service, close } = await realService();
  const log = memoryLogger();
  try {
    await configureSetupKey(service, testConfig({ SETUP_KEY: "" }), log);
    await configureSetupKey(service, testConfig({ SETUP_KEY: "short" }), log);
    assertEquals(await service.validateSetupToken(SYSTEM, { token: "short" }), { ok: false });
    assertEquals((await service.getSession(SYSTEM, {})).setupRequired, true);
    assertStringIncludes(String(log.lines[0].msg), "SETUP_KEY");
    assertEquals(log.lines.length, 2);
  } finally {
    close();
  }
});

test("setup key: installs the operator key without logging it and ignores it after setup", async () => {
  const { service, close } = await realService();
  const log = memoryLogger();
  try {
    await configureSetupKey(service, testConfig({ SETUP_KEY: KEY }), log);
    assertEquals(await service.validateSetupToken(SYSTEM, { token: KEY }), { ok: true });
    assertEquals(JSON.stringify(log.lines).includes(KEY), false);
    await service.completeSetup(ANONYMOUS, {
      token: KEY,
      email: "owner@example.com",
      displayName: "Owner",
      password: "correct horse battery",
      projectName: "Setup test",
    });
    await configureSetupKey(service, testConfig({ SETUP_KEY: "" }), log);
    await configureSetupKey(service, testConfig({ SETUP_KEY: "replacement-setup-key" }), log);
    assertEquals(log.lines.length, 1);
    assertEquals(await service.validateSetupToken(SYSTEM, { token: "replacement-setup-key" }), {
      ok: false,
    });
  } finally {
    close();
  }
});
