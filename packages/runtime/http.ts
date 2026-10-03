// SPDX-License-Identifier: MIT
interface Options {
  hostname?: string;
  port: number;
  onListen?(address: { hostname: string; port: number }): void;
}
interface ConnectionInfo {
  remoteAddr: { hostname: string };
}

/** Adapts Bun's connection metadata and graceful stop to the application handler. */
export function serveHttp(
  options: Options,
  handler: (request: Request, info: ConnectionInfo) => Response | Promise<Response>,
) {
  const stopped = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port,
    idleTimeout: 0,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch(request, server) {
      return handler(request, {
        remoteAddr: { hostname: server.requestIP(request)?.address ?? "" },
      });
    },
  });
  const addr = { hostname: server.hostname!, port: server.port! };
  options.onListen?.(addr);
  return {
    addr,
    finished: stopped.promise,
    async shutdown() {
      await server.stop();
      stopped.resolve();
    },
  };
}
export type HttpServer = ReturnType<typeof serveHttp>;
