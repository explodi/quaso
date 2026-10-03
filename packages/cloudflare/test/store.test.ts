// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createR2Store } from "../../service/src/adapters/r2_store.ts";
import { STORE_CASES } from "../../service/src/testing/store_cases.ts";
import { handleR2 } from "../src/r2_handler.ts";

const bucket = (env as unknown as { BACKUPS: R2Bucket }).BACKUPS;
const store = createR2Store({ fetch: (input, init) => handleR2(new Request(input, init), bucket) });

describe("R2 store through the private handler", () => {
  beforeEach(async () => {
    const keys = [];
    for await (const object of store.list("")) keys.push(object.key);
    await store.delete(keys);
  });
  for (const testCase of STORE_CASES) it(testCase.name, () => testCase.run(store));

  it("lists beyond one R2 page and deletes beyond one batch", async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `pages/${i}`);
    await Promise.all(keys.map((key) => bucket.put(key, new Uint8Array([1]))));
    const found = [];
    for await (const object of store.list("pages/")) found.push(object.key);
    expect(found.sort()).toEqual([...keys].sort());
    await store.delete(keys);
    expect((await bucket.list()).objects).toEqual([]);
  }, 20_000);

  it("has no public path and rejects malformed delete batches", async () => {
    expect((await handleR2(new Request("http://r2.quaso.internal/"), bucket)).status).toBe(404);
    expect(
      (
        await handleR2(
          new Request("http://r2.quaso.internal/objects", {
            method: "DELETE",
            body: '{"keys":[null]}',
          }),
          bucket,
        )
      ).status,
    ).toBe(400);
  });
});
