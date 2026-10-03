// SPDX-License-Identifier: MIT
import { Container } from "@cloudflare/containers";
import { GUARD_STATEMENTS } from "../../service/src/write.ts";
export { ContainerProxy } from "@cloudflare/containers";

interface SpikeEnv {
  NEAR: D1Database;
  FAR: D1Database;
  STORE: R2Bucket;
  SPIKE: DurableObjectNamespace<SpikeContainer>;
  TEST_KEY: string;
}

export class SpikeContainer extends Container<SpikeEnv> {
  override defaultPort = 8000;
  override sleepAfter = "20s";
  override enableInternet = false;

  override async onActivityExpired() {
    const health = (await (await this.containerFetch("http://container/healthz")).json()) as {
      busy: boolean;
    };
    await this.env.STORE.put(`events/${Date.now()}-activity`, JSON.stringify(health));
    if (health.busy) return;
    await this.stop();
  }

  async wake() {
    await this.containerFetch("http://container/healthz");
    await this.env.STORE.put(`events/${Date.now()}-wake`, "awake");
  }

  async wakeLater() {
    await this.schedule(60, "wake");
    return "scheduled";
  }

  async stopForTest() {
    await this.stop();
    return "stopped";
  }

  override async onStop(params: unknown) {
    await this.env.STORE.put(`events/${Date.now()}-stop`, JSON.stringify(params));
  }
}

SpikeContainer.outboundByHost = {
  "d1.quaso.internal": async (request: Request, bindings: unknown) => {
    const env = bindings as SpikeEnv;
    const input = (await request.json()) as {
      far?: boolean;
      statements: { sql: string; params?: unknown[] }[];
    };
    const database = input.far ? env.FAR : env.NEAR;
    const results = await database.batch(
      input.statements.map((s) => database.prepare(s.sql).bind(...(s.params ?? []))),
    );
    return Response.json(results);
  },
  "r2.quaso.internal": async (request: Request, bindings: unknown) => {
    const env = bindings as SpikeEnv;
    const key = new URL(request.url).pathname.slice(1);
    if (request.method === "PUT") {
      await env.STORE.put(key, request.body);
      return new Response("stored");
    }
    const object = await env.STORE.get(key);
    return new Response(object?.body ?? null, { status: object ? 200 : 404 });
  },
};

export default {
  async fetch(request: Request, env: SpikeEnv) {
    if (request.headers.get("Authorization") !== `Bearer ${env.TEST_KEY}`)
      return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    const container = env.SPIKE.get(env.SPIKE.idFromName("spike"), { locationHint: "weur" });
    if (path === "/initialize") {
      const schema = [
        { sql: "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT" },
        ...GUARD_STATEMENTS,
      ];
      await env.NEAR.batch(schema.map((s) => env.NEAR.prepare(s.sql)));
      await env.FAR.batch(schema.map((s) => env.FAR.prepare(s.sql)));
      return new Response("initialized");
    }
    if (path === "/events") {
      const listed = await env.STORE.list({ prefix: "events/" });
      const events = await Promise.all(
        listed.objects.map(async (o) => ({
          key: o.key,
          data: await (await env.STORE.get(o.key))!.text(),
        })),
      );
      return Response.json(events);
    }
    if (path === "/schedule") return new Response(await container.wakeLater());
    if (path === "/stop") return new Response(await container.stopForTest());
    return container.fetch(request);
  },
};
