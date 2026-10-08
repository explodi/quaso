// SPDX-License-Identifier: MIT
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readJson } from "./http/request.ts";
import { InFlight, stopServer } from "./shutdown.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A server whose handler reads a JSON body and echoes it, counted by an `InFlight`. */
function echoServer() {
  const inFlight = new InFlight();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    inFlight.wrap(async (request) => {
      try {
        return Response.json(await readJson(request, 1000));
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }),
  );
  return { inFlight, server, port: server.addr.port };
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
  const { inFlight, server, port } = echoServer();
  const body = JSON.stringify({ files: ["a.json"], dryRun: true });
  const connection = await startPost(port, body, 10);
  await wait(50);
  assertEquals(inFlight.count, 1);
  const stopping = stopServer(server, inFlight, 5000);
  await wait(50);
  const refused = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
  assertEquals(refused.status, 503);
  assertEquals(refused.headers.get("Retry-After"), "5");
  assertEquals((await refused.json()).error.code, "unavailable");
  await connection.write(encoder.encode(body.slice(10)));
  const response = await readAll(connection);
  assertStringIncludes(response, "HTTP/1.1 200");
  assertStringIncludes(response, body);
  connection.destroy();
  assertEquals(await stopping, true);
  await server.finished;
});

test("shutdown: a client that never finishes its body can't hold it past the deadline", async () => {
  const { inFlight, server, port } = echoServer();
  const connection = await startPost(port, JSON.stringify({ files: [] }), 3);
  await wait(50);
  const started = performance.now();
  assertEquals(await stopServer(server, inFlight, 200), false);
  const took = performance.now() - started;
  assert(took < 1000, `took ${Math.round(took)} ms`);
  connection.destroy();
  await server.finished;
});
