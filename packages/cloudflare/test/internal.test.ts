// SPDX-License-Identifier: MIT
/** Removed routes and private storage endpoints never wake the public container. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { env } from "./env.ts";
describe("private storage is absent from the public Worker", () => {
  it("refuses old internal RPC and recovery routes regardless of credentials", async () => {
    const container = env.QUASO_CONTAINER.get(env.QUASO_CONTAINER.idFromName("main"));
    const before = await container.served();
    const method = await SELF.fetch("https://quaso.test/internal/v1/upload", {
      method: "POST",
      headers: { Authorization: "Bearer test-service-token" },
      body: "{}",
    });
    const recovery = await SELF.fetch("https://quaso.test/internal/v1/pitr", {
      method: "POST",
      body: "{}",
    });
    const root = await SELF.fetch("https://quaso.test/internal");
    expect(method.status).toBe(404);
    expect(recovery.status).toBe(404);
    expect(root.status).toBe(404);
    expect(method.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await container.served()).toBe(before);
  });
  it("does not register private batch and object endpoints on the public Worker", async () => {
    expect(
      (await SELF.fetch("https://quaso.test/batch", { method: "POST", body: "{}" })).status,
    ).toBe(404);
    expect((await SELF.fetch("https://quaso.test/object?key=backups/private.json.gz")).status).toBe(
      404,
    );
    expect((await SELF.fetch("https://quaso.test/objects")).status).toBe(404);
  });
});
