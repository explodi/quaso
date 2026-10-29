// SPDX-License-Identifier: MIT
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { assert, expect, test } from "vitest";
import { readJson } from "./http/request.ts";
import { serve } from "./http/serve.ts";
import { InFlight, stopServer } from "./shutdown.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A server whose handler reads a JSON body and echoes it, counted by an `InFlight`. */
async function echoServer() {
  const inFlight = new InFlight();
  const server = await serve(
    { hostname: "127.0.0.1", port: 0 },
    inFlight.wrap(async (request) => {
      try {
        return Response.json(await readJson(request, 1000));
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }),
  );
  return { inFlight, server, port: server.port };
}

/** Sends the headers of a POST and the first `sent` bytes of `body`, on a raw connection. */
async function startPost(port: number, body: string, sent: number): Promise<Socket> {
  const connection = connect({ host: "127.0.0.1", port });
  await once(connection, "connect");
  const head =
    `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${encoder.encode(body).length}\r\n\r\n`;
  await connection.write(encoder.encode(head + body.slice(0, sent)));
  return connection;
}

async function readAll(connection: Socket): Promise<string> {
  let text = "";
  for await (const chunk of connection.iterator({ destroyOnReturn: false })) {
    text += decoder.decode(chunk);
    if (text.includes("\r\n\r\n") && /\}\s*$/.test(text)) break;
  }
  return text;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("shutdown: a request whose body is still arriving finishes; new ones get 503", async () => {
  const { inFlight, server, port } = await echoServer();
  const body = JSON.stringify({ files: ["a.json"], dryRun: true });
  const connection = await startPost(port, body, 10);
  await wait(50);
  expect(inFlight.count).toBe(1);
  const stopping = stopServer(server, inFlight, 5000);
  await wait(50);
  const refused = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
  expect(refused.status).toBe(503);
  expect(refused.headers.get("Retry-After")).toBe("5");
  expect((await refused.json()).error.code).toBe("unavailable");
  await connection.write(encoder.encode(body.slice(10)));
  const response = await readAll(connection);
  expect(response).toContain("HTTP/1.1 200");
  expect(response).toContain(body);
  connection.destroy();
  expect(await stopping).toBe(true);
});

test("shutdown: a client that never finishes its body can't hold it past the deadline", async () => {
  const { inFlight, server, port } = await echoServer();
  const connection = await startPost(port, JSON.stringify({ files: [] }), 3);
  await wait(50);
  const started = performance.now();
  expect(await stopServer(server, inFlight, 200)).toBe(false);
  const took = performance.now() - started;
  assert(took < 1000, `took ${Math.round(took)} ms`);
  connection.destroy();
  // Resolves when the abandoned shutdown has closed the last connection.
  await server.shutdown();
});
