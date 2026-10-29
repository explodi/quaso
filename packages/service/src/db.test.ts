// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(chunks([1, 2, 3, 4, 5], 2)).toStrictEqual([[1, 2], [3, 4], [5]]);
  expect(chunks([], 3)).toStrictEqual([]);
  expect(chunks([1, 2], 5)).toStrictEqual([[1, 2]]);
  expect(() => chunks([1], 0)).toThrow(RangeError);
});

test("forEachChunk keeps every statement within the parameter limit", () => {
  const sizes: number[] = [];
  forEachChunk(
    Array.from({ length: 50 }, (_, i) => i),
    12,
    (chunk) => sizes.push(chunk.length),
  );
  expect(sizes).toStrictEqual([8, 8, 8, 8, 8, 8, 2]);
  for (const size of sizes) expect(size * 12 <= SQL_MAX_PARAMS).toBe(true);
  const withExtra: number[] = [];
  forEachChunk([1, 2, 3, 4, 5], 20, (chunk) => withExtra.push(chunk.length), 20);
  expect(withExtra).toStrictEqual([4, 1]);
});

test("placeholders and idList", () => {
  expect(placeholders(3)).toBe("?, ?, ?");
  expect(idList([1, 22, 333])).toBe("1, 22, 333");
  expect(idList([])).toBe("NULL");
  expect(() => idList([1.5])).toThrow(TypeError);
  expect(() => idList([Number.NaN])).toThrow(TypeError);
});

test(
  "meta values can be set, read and deleted",
  withMeta((sql) => {
    expect(getMeta(sql, "x")).toBe(null);
    setMeta(sql, "x", "1");
    setMeta(sql, "x", "2");
    expect(getMeta(sql, "x")).toBe("2");
    deleteMeta(sql, "x");
    expect(getMeta(sql, "x")).toBe(null);
  }),
);

test(
  "bumpRevision raises the revision once per transaction",
  withMeta((sql) => {
    expect(getRevision(sql)).toBe(0);
    expect(transaction(sql, () => [bumpRevision(sql), bumpRevision(sql)])).toStrictEqual([1, 1]);
    expect(transaction(sql, () => bumpRevision(sql))).toBe(2);
    expect(getRevision(sql)).toBe(2);
    expect(bumpRevision(sql), "outside a transaction, every call raises it").toBe(3);
    expect(bumpRevision(sql)).toBe(4);
  }),
);

test(
  "bumpRevision raises again after a savepoint rolled it back",
  withMeta((sql) => {
    const result = transaction(sql, () => {
      expect(() =>
        transaction(sql, () => {
          bumpRevision(sql);
          throw new Error("rolled back");
        }),
      ).toThrow();
      return bumpRevision(sql);
    });
    expect(result).toBe(1);
    expect(getRevision(sql)).toBe(1);
  }),
);

test(
  "a rolled-back transaction leaves the revision as it was",
  withMeta((sql) => {
    expect(() =>
      transaction(sql, () => {
        bumpRevision(sql);
        throw new Error("no");
      }),
    ).toThrow();
    expect(getRevision(sql)).toBe(0);
    expect(transaction(sql, () => bumpRevision(sql))).toBe(1);
  }),
);

test("normalizeSearch uses NFKC and lower case", () => {
  expect(normalizeSearch("ＰＬＡＹ Straße ﬁ")).toBe("play straße fi");
  expect(normalizeSearch("É")).toBe("é");
});
