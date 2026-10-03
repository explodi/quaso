// SPDX-License-Identifier: MIT
import { Container } from "@cloudflare/containers";
import { handleD1 } from "../src/d1_handler.ts";
export { ContainerProxy } from "@cloudflare/containers";

interface ContractEnv {
  DB: D1Database;
  CONTROLLER: DurableObjectNamespace<ContractContainer>;
  TEST_KEY: string;
}

export class ContractContainer extends Container<ContractEnv> {
  override defaultPort = 8000;
  override sleepAfter = "10m";
  override enableInternet = false;
}

ContractContainer.outboundByHost = {
  "d1.quaso.internal": (request: Request, bindings: unknown) =>
    handleD1(request, (bindings as ContractEnv).DB),
};

export default {
  async fetch(request: Request, env: ContractEnv) {
    if (request.headers.get("Authorization") !== `Bearer ${env.TEST_KEY}`)
      return new Response(null, { status: 404 });
    if (new URL(request.url).pathname === "/ready") return Response.json({ ready: true });
    const url = new URL(request.url);
    if (url.pathname === "/limits") {
      const started = performance.now();
      let completed = 0;
      try {
        if (url.searchParams.has("invocation")) {
          const count = Number(url.searchParams.get("invocation"));
          if (count !== 1000 && count !== 1001) return new Response(null, { status: 400 });
          for (let i = 0; i < count; i++) {
            await env.DB.prepare("SELECT 1 AS value").first();
            completed++;
          }
          return Response.json({ ok: true, completed, elapsedMs: performance.now() - started });
        }
        let statements: D1PreparedStatement[];
        if (url.searchParams.has("batch")) {
          const count = Number(url.searchParams.get("batch"));
          if (!Number.isInteger(count) || count < 1 || count > 1001)
            return new Response(null, { status: 400 });
          statements = Array.from({ length: count }, () => env.DB.prepare("SELECT 1 AS value"));
        } else if (url.searchParams.has("params")) {
          const count = Number(url.searchParams.get("params"));
          if (count !== 100 && count !== 101) return new Response(null, { status: 400 });
          statements = [
            env.DB.prepare(
              `SELECT 1 IN (${Array.from({ length: count }, () => "?").join(", ")}) AS value`,
            ).bind(...Array(count).fill(1)),
          ];
        } else {
          const length = Number(url.searchParams.get("length"));
          if (length !== 100000 && length !== 100001) return new Response(null, { status: 400 });
          const base = "SELECT 1 /* */";
          statements = [env.DB.prepare(`SELECT 1 /*${"x".repeat(length - base.length)} */`)];
        }
        const rows = await env.DB.batch(statements);
        return Response.json({
          ok: true,
          statements: rows.length,
          region: rows[0]?.meta.served_by_region,
          elapsedMs: performance.now() - started,
        });
      } catch (error) {
        return Response.json({
          ok: false,
          completed,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: performance.now() - started,
        });
      }
    }
    return env.CONTROLLER.get(env.CONTROLLER.idFromName("contract"), {
      locationHint: "weur",
    }).fetch(request);
  },
};
