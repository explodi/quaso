// SPDX-License-Identifier: MIT
import type { Store } from "../ports.ts";
import { checkStoreCondition, validateStoreKey } from "../store.ts";

export function createMemoryStore(): Store {
  const objects = new Map<string, { bytes: Uint8Array; version: string }>();
  return {
    async read(key) {
      validateStoreKey(key);
      return objects.get(key)?.bytes.slice() ?? null;
    },
    async write(key, bytes, options) {
      validateStoreKey(key);
      checkStoreCondition(objects.get(key)?.version, options?.ifMatch);
      const version = crypto.randomUUID();
      objects.set(key, { bytes: bytes.slice(), version });
      return { version };
    },
    async *list(prefix) {
      const listed = [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [key, object] of listed)
        yield { key, size: object.bytes.length, version: object.version };
    },
    async delete(keys) {
      keys.forEach(validateStoreKey);
      for (const key of keys) objects.delete(key);
    },
  };
}
