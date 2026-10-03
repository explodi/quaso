// SPDX-License-Identifier: MIT
/** The container's settings, from the Worker's (the container itself needs Docker). */
import { describe, expect, it } from "vitest";
import { containerEnv, DEFAULT_SLEEP_AFTER, locationHint, sleepAfter } from "../src/container.ts";
import { env } from "./env.ts";

describe("the container's settings", () => {
  it("gives the server what it needs for Cloudflare storage", () => {
    const vars = containerEnv({
      ...env,
      PUBLIC_URL: "https://translate.yourgame.com/",
      EMAIL_PROVIDER: "resend",
      EMAIL_API_KEY: "re_123",
      EMAIL_FROM: "Quaso <quaso@yourgame.com>",
      GITHUB_CLIENT_ID: "  ",
      GEMINI_API_KEY: "test-provider-key",
      SETUP_KEY: "first-administrator-key",
    } as unknown as Env);
    expect(vars).toEqual({
      PORT: "8000",
      PUBLIC_URL: "https://translate.yourgame.com",
      QUASO_CLOUDFLARE: "true",
      SECRET_KEY: env.SECRET_KEY,
      TRUST_PROXY: "true",
      EMAIL_PROVIDER: "resend",
      EMAIL_API_KEY: "re_123",
      EMAIL_FROM: "Quaso <quaso@yourgame.com>",
      GEMINI_API_KEY: "test-provider-key",
      LLM_CONCURRENCY: "4",
      BACKUP_RETENTION_DAYS: "30",
      SETUP_KEY: "first-administrator-key",
    });
    expect(vars).not.toHaveProperty("SERVICE_TOKEN");
  });

  it("does not redirect private storage through a public URL", () => {
    const vars = containerEnv({
      ...env,
      SERVICES_URL: "http://host.docker.internal:8787/internal",
    } as unknown as Env);
    expect(vars).not.toHaveProperty("SERVICES_URL");
    expect(vars.PUBLIC_URL).toBe("https://quaso.test");
  });

  it("reads the sleep timeout", () => {
    expect(sleepAfter({ CONTAINER_SLEEP_AFTER: "5m" })).toBe("5m");
    expect(sleepAfter({ CONTAINER_SLEEP_AFTER: "90s" })).toBe("90s");
    for (const bad of ["", "soon", "10", "5 m", "0s"]) {
      expect(sleepAfter({ CONTAINER_SLEEP_AFTER: bad })).toBe(DEFAULT_SLEEP_AFTER);
    }
  });

  it("reads the location hint", () => {
    expect(locationHint("weur")).toBe("weur");
    expect(locationHint(" ENAM ")).toBe("enam");
    expect(locationHint("")).toBeUndefined();
    expect(locationHint("mars")).toBeUndefined();
  });
});

describe("the Worker's main module", () => {
  it("exports only the handler and the Durable Object classes", async () => {
    const main: Record<string, unknown> = await import("../src/worker.ts");
    expect(Object.keys(main).sort()).toEqual(["ContainerProxy", "QuasoContainer", "default"]);
    expect(typeof (main.default as ExportedHandler).fetch).toBe("function");
  });
});
