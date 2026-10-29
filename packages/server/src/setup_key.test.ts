// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
    expect(await service.validateSetupToken(SYSTEM, { token: "short" })).toStrictEqual({
      ok: false,
    });
    expect((await service.getSession(SYSTEM, {})).setupRequired).toBe(true);
    expect(String(log.lines[0].msg)).toContain("SETUP_KEY");
    expect(log.lines.length).toBe(2);
  } finally {
    close();
  }
});

test("setup key: installs the operator key without logging it and ignores it after setup", async () => {
  const { service, close } = await realService();
  const log = memoryLogger();
  try {
    await configureSetupKey(service, testConfig({ SETUP_KEY: KEY }), log);
    expect(await service.validateSetupToken(SYSTEM, { token: KEY })).toStrictEqual({ ok: true });
    expect(JSON.stringify(log.lines).includes(KEY)).toBe(false);
    await service.completeSetup(ANONYMOUS, {
      token: KEY,
      email: "owner@example.com",
      displayName: "Owner",
      password: "correct horse battery",
      projectName: "Setup test",
    });
    await configureSetupKey(service, testConfig({ SETUP_KEY: "" }), log);
    await configureSetupKey(service, testConfig({ SETUP_KEY: "replacement-setup-key" }), log);
    expect(log.lines.length).toBe(1);
    expect(
      await service.validateSetupToken(SYSTEM, { token: "replacement-setup-key" }),
    ).toStrictEqual({
      ok: false,
    });
  } finally {
    close();
  }
});
