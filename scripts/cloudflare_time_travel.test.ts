// SPDX-License-Identifier: MIT
import { exists } from "@std/fs/exists";
import { test } from "node:test";
import { expect } from "@std/expect";
import * as fs from "node:fs/promises";
import { CloudflareApi } from "../packages/cloudflare/scripts/cloudflare_api.ts";
import { restoreTimeTravel } from "../packages/cloudflare/scripts/time_travel.ts";
import { restoreOptions } from "../packages/cloudflare/scripts/restore.ts";

const instance = {
  accountId: "0123456789abcdef0123456789abcdef",
  hostname: "translate.example.com",
  workerName: "quaso-example",
  databaseId: "12345678-1234-1234-1234-123456789abc",
  databaseName: "quaso-example",
  bucketName: "quaso-example-store",
  locationHint: "weur",
  sleepAfter: "5m",
  image: "example/quaso:1.0.0-beta.2",
};
const bookmark = "00000001-00000002-00004e2f-" + "a".repeat(32);
const previous = "00000002-00000002-00004e2f-" + "b".repeat(32);
function fixture() {
  const events: string[] = [];
  const messages: string[] = [];
  const paths: string[] = [];
  const forces: boolean[] = [];
  const state = {
    failRestore: false,
    failPause: false,
    failResumeDeploy: false,
    invalidBookmark: false,
    failCleanup: false,
    wrongDatabase: false,
    wrongDomain: false,
    key: "",
  };
  const api = new CloudflareApi({ type: "oauth", token: "private-oauth" }, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    let result: unknown = {};
    if (path.endsWith("/settings")) {
      events.push("settings");
      result = {
        bindings: [
          {
            name: "DB",
            type: "d1",
            database_id: state.wrongDatabase ? "other" : instance.databaseId,
          },
          { name: "BACKUPS", type: "r2_bucket", bucket_name: instance.bucketName },
        ],
      };
    } else if (path.endsWith("/domains")) {
      events.push("domains");
      result = [
        { hostname: instance.hostname, service: state.wrongDomain ? "other" : instance.workerName },
      ];
    } else if (path.endsWith("/bookmark")) {
      const historical = new URL(String(url)).searchParams.has("timestamp");
      events.push(historical ? "target bookmark" : "current bookmark");
      result = { bookmark: state.invalidBookmark ? undefined : historical ? bookmark : previous };
    } else if (path.endsWith("/restore")) {
      events.push("restore");
      expect(new URL(String(url)).searchParams.get("bookmark")).toBe(bookmark);
      expect(method).toBe("POST");
      if (state.failRestore)
        return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 500 });
      result = { bookmark, previous_bookmark: previous };
    } else if (method === "PUT") {
      events.push("create key");
      const body = JSON.parse(String(init?.body));
      expect(body.name).toBe("QUASO_RESTORE_KEY");
      expect(body.type).toBe("secret_text");
      state.key = body.text;
    } else if (method === "DELETE") {
      events.push("delete key");
      if (state.failCleanup)
        return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 500 });
    } else throw new Error(`Unexpected API request ${method} ${path}`);
    return Response.json({ success: true, result });
  });
  const dependencies = {
    connect: async () => ({
      api,
      identity: { loggedIn: true, accounts: [{ id: instance.accountId, name: "test" }] },
    }),
    run: async (args: string[]) => {
      expect(args[0]).toBe("deploy");
      expect(args.slice(-2)).toEqual(["--containers-rollout", "none"]);
      const path = args[2];
      paths.push(path);
      const config = JSON.parse(await fs.readFile(path, "utf8"));
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
      expect(config.env.staging.containers[0].image).toBe(`docker.io/${instance.image}`);
      const paused = config.env.staging.vars.QUASO_RESTORE_PAUSED === "true";
      events.push(paused ? "deploy pause" : "deploy resume");
      return { code: !paused && state.failResumeDeploy ? 1 : 0, stdout: "" };
    },
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/healthz") {
        events.push("health");
        return Response.json({ ok: true, storage: "cloudflare" });
      }
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${state.key}`);
      const operation = path.endsWith("/pause") ? "pause" : "resume";
      forces.push(JSON.parse(String(init?.body)).force);
      events.push(operation);
      if (operation === "pause" && state.failPause)
        return new Response("unconfirmed stop", { status: 503 });
      return Response.json({ ok: true });
    },
    print: (message: string) => {
      messages.push(message);
    },
    wait: async () => {},
  };
  return { state, events, messages, paths, forces, dependencies };
}

test("stops the container before D1 restoration, records undo and resumes without rebuilding", async () => {
  const f = fixture();
  expect(
    await restoreTimeTravel(
      instance,
      "staging",
      { timestamp: "2026-10-03T00:00:00.000Z" },
      f.dependencies,
    ),
  ).toEqual({ bookmark, previous_bookmark: previous });
  expect(f.events).toEqual([
    "settings",
    "domains",
    "target bookmark",
    "create key",
    "deploy pause",
    "pause",
    "current bookmark",
    "restore",
    "deploy resume",
    "resume",
    "delete key",
    "health",
  ]);
  expect(f.messages.join("\n")).toContain(`Previous bookmark (save to undo): ${previous}`);
  expect(f.messages.join("\n")).not.toContain(f.state.key);
  expect(f.messages.join("\n")).not.toContain("private-oauth");
  expect(await exists(f.paths[0])).toBe(false);
  expect(f.forces).toEqual([false, false]);
});

test("failed D1 restoration leaves maintenance enabled and removes its key and local config", async () => {
  const f = fixture();
  f.state.failRestore = true;
  await expect(
    restoreTimeTravel(instance, "staging", { bookmark }, f.dependencies),
  ).rejects.toThrow("HTTP 500");
  expect(f.events).toEqual([
    "settings",
    "domains",
    "create key",
    "deploy pause",
    "pause",
    "current bookmark",
    "restore",
    "delete key",
  ]);
  expect(f.messages.join("\n")).toContain("Maintenance mode may remain enabled");
  expect(await exists(f.paths[0])).toBe(false);
});

test("does not restore D1 when the container stop is unconfirmed", async () => {
  const f = fixture();
  f.state.failPause = true;
  await expect(
    restoreTimeTravel(instance, "staging", { bookmark }, f.dependencies),
  ).rejects.toThrow("pause failed");
  expect(f.events).toEqual([
    "settings",
    "domains",
    "create key",
    "deploy pause",
    "pause",
    "delete key",
  ]);
  expect(await exists(f.paths[0])).toBe(false);
});

test("keeps the undo bookmark available when the normal Worker redeployment fails", async () => {
  const f = fixture();
  f.state.failResumeDeploy = true;
  await expect(
    restoreTimeTravel(instance, "staging", { bookmark }, f.dependencies),
  ).rejects.toThrow("remove restoration maintenance");
  expect(f.messages.join("\n")).toContain(`Undo bookmark: ${previous}`);
  expect(f.events.at(-1)).toBe("delete key");
  expect(await exists(f.paths[0])).toBe(false);
});

test("explicit recovery resumes maintenance without restoring D1 again", async () => {
  const f = fixture();
  expect(await restoreTimeTravel(instance, "staging", { resume: true }, f.dependencies)).toEqual({
    resumed: true,
  });
  expect(f.events).toEqual([
    "settings",
    "domains",
    "create key",
    "deploy pause",
    "deploy resume",
    "resume",
    "delete key",
    "health",
  ]);
  expect(f.forces).toEqual([true]);
});

test("explicit takeover acquires the failed pause but only resumes its own operation", async () => {
  const f = fixture();
  await restoreTimeTravel(instance, "staging", { bookmark, takeover: true }, f.dependencies);
  expect(f.forces).toEqual([true, false]);
});

test("missing target bookmarks stop before any maintenance or secret mutation", async () => {
  const f = fixture();
  f.state.invalidBookmark = true;
  await expect(
    restoreTimeTravel(
      instance,
      "staging",
      { timestamp: "2026-10-03T00:00:00.000Z" },
      f.dependencies,
    ),
  ).rejects.toThrow("valid restore bookmark");
  expect(f.events).toEqual(["settings", "domains", "target bookmark"]);
});

test("a failed restore and failed key cleanup preserve both errors", async () => {
  const f = fixture();
  f.state.failRestore = true;
  f.state.failCleanup = true;
  await expect(
    restoreTimeTravel(instance, "staging", { bookmark }, f.dependencies),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(f.events.at(-1)).toBe("delete key");
});

test("mismatched deployed bindings and hostnames fail before mutation", async () => {
  const wrongDatabase = fixture();
  wrongDatabase.state.wrongDatabase = true;
  await expect(
    restoreTimeTravel(instance, "staging", { bookmark }, wrongDatabase.dependencies),
  ).rejects.toThrow("different D1 or R2");
  expect(wrongDatabase.events).toEqual(["settings"]);
  const wrongDomain = fixture();
  wrongDomain.state.wrongDomain = true;
  await expect(
    restoreTimeTravel(instance, "staging", { bookmark }, wrongDomain.dependencies),
  ).rejects.toThrow("does not route");
  expect(wrongDomain.events).toEqual(["settings", "domains"]);
});

test("restore options select one source and normalize timestamps", () => {
  expect(restoreOptions(["--env", "staging", "--at", "1"]).at).toBe("1970-01-01T00:00:01.000Z");
  expect(restoreOptions(["--env", "staging", "--bookmark", bookmark]).bookmark).toBe(bookmark);
  expect(restoreOptions(["--env", "staging", "--resume"]).resume).toBe(true);
  expect(restoreOptions(["--env", "staging", "--bookmark", bookmark, "--takeover"]).takeover).toBe(
    true,
  );
  expect(() => restoreOptions(["--env", "staging", "--resume", "--takeover"])).toThrow(
    "only for a Time Travel retry",
  );
  expect(() => restoreOptions(["--env", "staging", "--file", "backup", "--resume"])).toThrow(
    "exactly one",
  );
  expect(() => restoreOptions(["--env", "staging", "--at", "2099-01-01T00:00:00Z"])).toThrow(
    "past",
  );
  expect(() => restoreOptions(["--env", "staging", "--bookmark", "invalid"])).toThrow(
    "valid D1 bookmark",
  );
  expect(() => restoreOptions(["--env", "staging", "--at", "2026-02-30T00:00:00Z"])).toThrow(
    "valid calendar date",
  );
});
