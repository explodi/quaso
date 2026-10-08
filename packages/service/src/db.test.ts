// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertThrows } from "@std/assert";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import {
  bumpRevision,
  chunks,
  deleteMeta,
  forEachChunk,
  getMeta,
  getRevision,
  idList,
  normalizeSearch,
  placeholders,
  setMeta,
  transaction,
} from "./db.ts";
import { SQL_MAX_PARAMS } from "./ports.ts";

function withMeta(fn: (sql: ReturnType<typeof openNodeSqlite>["sql"]) => void) {
  return () => {
    const database = openNodeSqlite(":memory:");
    try {
      database.sql.script("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
      fn(database.sql);
    } finally {
      database.close();
    }
  };
}

test("chunks splits a list into lists of at most the size", () => {
  assertEquals(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunks([], 3), []);
  assertEquals(chunks([1, 2], 5), [[1, 2]]);
  assertThrows(() => chunks([1], 0), RangeError);
});

test("forEachChunk keeps every statement within the parameter limit", () => {
  const sizes: number[] = [];
  forEachChunk(
    Array.from({ length: 50 }, (_, i) => i),
    12,
    (chunk) => sizes.push(chunk.length),
  );
  assertEquals(sizes, [8, 8, 8, 8, 8, 8, 2]);
  for (const size of sizes) assertEquals(size * 12 <= SQL_MAX_PARAMS, true);
  const withExtra: number[] = [];
  forEachChunk([1, 2, 3, 4, 5], 20, (chunk) => withExtra.push(chunk.length), 20);
  assertEquals(withExtra, [4, 1]);
});

test("placeholders and idList", () => {
  assertEquals(placeholders(3), "?, ?, ?");
  assertEquals(idList([1, 22, 333]), "1, 22, 333");
  assertEquals(idList([]), "NULL");
  assertThrows(() => idList([1.5]), TypeError);
  assertThrows(() => idList([Number.NaN]), TypeError);
});

test(
  "meta values can be set, read and deleted",
  withMeta((sql) => {
    assertEquals(getMeta(sql, "x"), null);
    setMeta(sql, "x", "1");
    setMeta(sql, "x", "2");
    assertEquals(getMeta(sql, "x"), "2");
    deleteMeta(sql, "x");
    assertEquals(getMeta(sql, "x"), null);
  }),
);

test(
  "bumpRevision raises the revision once per transaction",
  withMeta((sql) => {
    assertEquals(getRevision(sql), 0);
    assertEquals(
      transaction(sql, () => [bumpRevision(sql), bumpRevision(sql)]),
      [1, 1],
    );
    assertEquals(
      transaction(sql, () => bumpRevision(sql)),
      2,
    );
    assertEquals(getRevision(sql), 2);
    assertEquals(bumpRevision(sql), 3, "outside a transaction, every call raises it");
    assertEquals(bumpRevision(sql), 4);
  }),
);

test(
  "bumpRevision raises again after a savepoint rolled it back",
  withMeta((sql) => {
    const result = transaction(sql, () => {
      assertThrows(() =>
        transaction(sql, () => {
          bumpRevision(sql);
          throw new Error("rolled back");
        }),
      );
      return bumpRevision(sql);
    });
    assertEquals(result, 1);
    assertEquals(getRevision(sql), 1);
  }),
);

test(
  "a rolled-back transaction leaves the revision as it was",
  withMeta((sql) => {
    assertThrows(() =>
      transaction(sql, () => {
        bumpRevision(sql);
        throw new Error("no");
      }),
    );
    assertEquals(getRevision(sql), 0);
    assertEquals(
      transaction(sql, () => bumpRevision(sql)),
      1,
    );
  }),
);

test("normalizeSearch uses NFKC and lower case", () => {
  assertEquals(normalizeSearch("ＰＬＡＹ Straße ﬁ"), "play straße fi");
  assertEquals(normalizeSearch("É"), "é");
});
