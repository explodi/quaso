// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restore, restoreOptions } from "../packages/cloudflare/scripts/restore.ts";

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "quaso-restore-test-"));
  const configPath = join(directory, "instance.jsonc");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      environments: {
        staging: {
          accountId: "0123456789abcdef0123456789abcdef",
          hostname: "translate.example.com",
          workerName: "quaso-example",
          databaseId: "12345678-1234-1234-1234-123456789abc",
          databaseName: "quaso-example",
          bucketName: "quaso-example-store",
          locationHint: "weur",
          sleepAfter: "5m",
          image: "ghcr.io/explodi/quaso:1.0.0-beta.2",
        },
      },
    }),
  );
  const file = join(directory, "backup.json");
  await fs.writeFile(file, '{"version":1,"tables":{}}');
  return {
    directory,
    file,
    args: ["--env", "staging", "--instance-config", configPath, "--file", file],
  };
}

test("streams a backup to the configured HTTPS origin without logging the setup key or altering input", async () => {
  const f = await fixture();
  const messages: string[] = [];
  try {
    const result = await restore(f.args, {
      key: async () => "private-setup-key",
      print: (message) => {
        messages.push(message);
      },
      fetch: async (url, init) => {
        expect(url).toBe("https://translate.example.com/api/v1/restore");
        expect(init?.redirect).toBe("error");
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("X-Setup-Key")).toBe("private-setup-key");
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("Content-Length")).toBe("25");
        expect(await new Response(init?.body).text()).toBe('{"version":1,"tables":{}}');
        return Response.json({ schemaVersion: { from: 5, to: 5 }, tables: {} });
      },
    });
    expect(result.tables).toEqual({});
    expect(messages.join("\n")).not.toContain("private-setup-key");
    expect(await fs.readFile(f.file, "utf8")).toBe('{"version":1,"tables":{}}');
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test("detects gzip backup content independently of its filename", async () => {
  const f = await fixture();
  try {
    const gzip = Bun.gzipSync('{"version":1,"tables":{}}');
    await fs.writeFile(f.file, gzip);
    await restore(f.args, {
      key: async () => "key",
      print: () => {},
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("Content-Type")).toBe("application/gzip");
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(gzip);
        return Response.json({ tables: {} });
      },
    });
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test("does not reflect a rejected restore's secret-bearing response body", async () => {
  const f = await fixture();
  try {
    await expect(
      restore(f.args, {
        key: async () => "key",
        print: () => {},
        fetch: async () => new Response("private-setup-key", { status: 403 }),
      }),
    ).rejects.toThrow("Check the setup key and that the instance is empty");
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test("rejects empty backup files before asking for a setup key or sending a request", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.file, "");
    await expect(
      restore(f.args, {
        key: async () => {
          throw new Error("Unexpected key prompt");
        },
      }),
    ).rejects.toThrow("nonempty backup");
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test("requires an explicit restore target and refuses conflicting options", () => {
  expect(() => restoreOptions(["--file", "backup.json"])).toThrow("--env");
  expect(() => restoreOptions(["--env", "dev", "--file", "backup.json"])).toThrow(
    "staging or production",
  );
  expect(() =>
    restoreOptions(["--env", "staging", "--env", "production", "--file", "backup.json"]),
  ).toThrow("once");
  expect(() => restoreOptions(["--env", "staging", "--at", "invalid-time"])).toThrow(
    "past Unix timestamp",
  );
  expect(() => restoreOptions(["--env", "staging", "--file"])).toThrow("needs a value");
});
