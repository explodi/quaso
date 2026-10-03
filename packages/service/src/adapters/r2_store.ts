// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { ServiceError } from "../errors.ts";
import type { Store, StoredObject } from "../ports.ts";
import { StoreConflict, validateStoreKey } from "../store.ts";

/** The container reaches its private bucket through the outbound binding handler. */
export function createR2Store(options: { fetch?: Fetch } = {}): Store {
  const doFetch = options.fetch ?? fetch;
  async function request(path: string, params: Record<string, string>, init?: RequestInit) {
    const url = new URL(path, "http://r2.quaso.internal");
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(35_000) });
    } catch {
      throw unavailable();
    }
  }
  async function check(response: Response) {
    if (response.status === 412) {
      await response.body?.cancel();
      throw new StoreConflict();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
  }
  return {
    async read(key) {
      validateStoreKey(key);
      const response = await request("/object", { key });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      await check(response);
      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        throw unavailable();
      }
    },
    async write(key, bytes, condition) {
      validateStoreKey(key);
      const params: Record<string, string> = { key };
      if (condition?.ifMatch !== undefined) params.match = condition.ifMatch;
      const response = await request("/object", params, { method: "PUT", body: bytes.slice() });
      await check(response);
      const value = (await response.json().catch(() => null)) as { version?: unknown } | null;
      if (typeof value?.version !== "string") throw unavailable();
      return { version: value.version };
    },
    async *list(prefix) {
      let cursor: string | undefined;
      do {
        const response = await request(
          "/objects",
          cursor === undefined ? { prefix } : { prefix, cursor },
        );
        await check(response);
        const page = (await response.json().catch(() => null)) as {
          items?: unknown;
          cursor?: unknown;
        } | null;
        if (
          !Array.isArray(page?.items) ||
          (page.cursor !== undefined && typeof page.cursor !== "string")
        )
          throw unavailable();
        for (const item of page.items) {
          if (
            typeof item?.key !== "string" ||
            typeof item.version !== "string" ||
            !Number.isSafeInteger(item.size) ||
            item.size < 0
          )
            throw unavailable();
          yield item as StoredObject;
        }
        if (page.cursor !== undefined && page.cursor === cursor) throw unavailable();
        cursor = page.cursor;
      } while (cursor !== undefined);
    },
    async delete(keys) {
      keys.forEach(validateStoreKey);
      for (let start = 0; start < keys.length; start += 1000) {
        const response = await request(
          "/objects",
          {},
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keys: keys.slice(start, start + 1000) }),
          },
        );
        await check(response);
        await response.body?.cancel();
      }
    },
  };
}

function unavailable() {
  return new ServiceError("unavailable", "The object store is unavailable. Try again shortly.");
}
