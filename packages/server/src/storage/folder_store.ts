// SPDX-License-Identifier: MIT
import { mkdir, open, readFile, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Hex } from "@quaso/core";
import type { Store } from "@quaso/service";
import { checkStoreCondition, validateStoreKey } from "../../../service/src/store.ts";
import { acquireLock } from "./lock.ts";

/** Each immutable file holds metadata and body together, so rename publishes both. */
export function createFolderStore(dir: string): Store {
  const root = resolve(dir);
  const objects = join(root, "objects");
  const objectPath = (key: string) => {
    validateStoreKey(key);
    return join(objects, sha256Hex(key));
  };
  const locked = async <T>(run: () => Promise<T>): Promise<T> => {
    await mkdir(objects, { recursive: true });
    const lock = await acquireLock(root);
    try {
      // The OS releases the lock after a crash; leftover unpublished files are disposable.
      for (const name of await readdir(objects))
        if (name.startsWith(".tmp-")) await unlink(join(objects, name));
      return await run();
    } finally {
      lock.release();
    }
  };
  return {
    async read(key) {
      try {
        const bytes = await readFile(objectPath(key));
        const { offset } = header(bytes);
        return new Uint8Array(bytes.subarray(offset));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async write(key, bytes, options) {
      const path = objectPath(key);
      const body = bytes.slice();
      return locked(async () => {
        let current: string | undefined;
        try {
          const file = await open(path, "r");
          try {
            current = (await readHeader(file)).version;
          } finally {
            await file.close();
          }
        } catch (error) {
          if (!missing(error)) throw error;
        }
        checkStoreCondition(current, options?.ifMatch);
        const version = crypto.randomUUID();
        const temporary = join(objects, `.tmp-${version}`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify({ key, version }) + "\n");
            await file.writeFile(body);
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path);
          const directory = await open(objects, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          return { version };
        } finally {
          await unlink(temporary).catch((error) => {
            if (!missing(error)) throw error;
          });
        }
      });
    },
    async *list(prefix) {
      let names: string[];
      try {
        names = await readdir(objects);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      const listed = [];
      for (const name of names) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        let file: FileHandle;
        try {
          file = await open(join(objects, name), "r");
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        try {
          const metadata = await readHeader(file);
          if (!metadata.key.startsWith(prefix)) continue;
          const stat = await file.stat();
          listed.push({
            key: metadata.key,
            size: stat.size - metadata.offset,
            version: metadata.version,
          });
        } finally {
          await file.close();
        }
      }
      listed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      yield* listed;
    },
    async delete(keys) {
      const paths = keys.map(objectPath);
      if (paths.length === 0) return;
      await locked(async () => {
        for (const path of paths)
          await unlink(path).catch((error) => {
            if (!missing(error)) throw error;
          });
        const directory = await open(objects, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      });
    },
  };
}

async function readHeader(file: FileHandle) {
  const buffer = new Uint8Array(8192);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  return header(buffer.subarray(0, bytesRead));
}

function header(bytes: Uint8Array): { key: string; version: string; offset: number } {
  const end = bytes.indexOf(10);
  if (end < 0) throw new Error("Invalid object-store metadata");
  const value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
  if (typeof value.key !== "string" || typeof value.version !== "string")
    throw new Error("Invalid object-store metadata");
  return { key: value.key, version: value.version, offset: end + 1 };
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
