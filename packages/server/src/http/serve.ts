// SPDX-License-Identifier: MIT
/**
 * A fetch-style HTTP server on `node:http`: each request reaches the handler as a web
 * `Request`, and the `Response` it returns is streamed back. The request's `signal` aborts
 * when the client goes away before the response is finished.
 */
import * as http from "node:http";
import * as net from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export interface ConnectionInfo {
  remoteAddr: { hostname: string; port: number };
}

export type Handler = (request: Request, info: ConnectionInfo) => Response | Promise<Response>;

export interface ServeOptions {
  port: number;
  /** Defaults to every IPv4 interface, so clients' addresses aren't IPv6-mapped. */
  hostname?: string;
}

export interface Server {
  /** Where the server listens, with the port the system chose when asked for port 0. */
  hostname: string;
  port: number;
  /**
   * Stops taking connections, lets the responses in progress finish, then closes every
   * connection. Resolves once they are all closed.
   */
  shutdown(): Promise<void>;
}

/** Listens on `options`; rejects with the system's error, such as `EADDRINUSE`. */
export async function serve(options: ServeOptions, handler: Handler): Promise<Server> {
  let closing = false;
  const server = http.createServer((incoming, outgoing) => {
    void respond(incoming, outgoing, handler, () => closing);
  });
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(options.port, options.hostname ?? "0.0.0.0", () => {
      server.off("error", failed);
      listening();
    });
  });
  const address = server.address() as net.AddressInfo;
  return {
    hostname: address.address,
    port: address.port,
    shutdown() {
      closing = true;
      return new Promise((closed) => {
        server.close(() => closed());
        server.closeIdleConnections();
      });
    },
  };
}

/** A port nothing listens on right now, for a server started by another process. */
export async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((listening) => listener.listen(0, "127.0.0.1", listening));
  const { port } = listener.address() as net.AddressInfo;
  await new Promise((closed) => listener.close(closed));
  return port;
}

async function respond(
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  handler: Handler,
  isClosing: () => boolean,
): Promise<void> {
  const aborted = new AbortController();
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) aborted.abort();
  });
  let response: Response;
  try {
    response = await handler(toRequest(incoming, aborted.signal), {
      remoteAddr: {
        hostname: incoming.socket.remoteAddress ?? "",
        port: incoming.socket.remotePort ?? 0,
      },
    });
  } catch (error) {
    console.error("The request handler failed:", error);
    response = new Response("Internal Server Error", { status: 500 });
  }
  if (outgoing.destroyed) {
    await response.body?.cancel();
    return;
  }

  outgoing.statusCode = response.status;
  if (response.statusText) outgoing.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
  // Without this, a keep-alive connection would hold a shutting-down server open.
  if (isClosing()) outgoing.setHeader("connection", "close");

  if (!response.body) {
    outgoing.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), outgoing);
  } catch {
    // The client went away mid-response; the pipeline has cancelled the body.
  }
}

function toRequest(incoming: http.IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) headers.append(raw[i], raw[i + 1]);
  const host = headers.get("host") ?? "localhost";
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    signal,
    body: hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null,
    // Required by fetch for a streamed request body.
    duplex: "half",
  } as RequestInit);
}
