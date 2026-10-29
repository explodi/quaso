// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { formatPath, type Infer, parse, s, SchemaError, toJsonSchema, validate } from "./schema.ts";

const Upload = s.object({
  files: s.array(
    s.object({
      path: s.string({ minLength: 1 }).describe("Path below the source folder"),
      content: s.string(),
    }),
    { minItems: 1 },
  ),
  dryRun: s.boolean().optional(),
  mode: s.enum(["full", "partial"]).optional(),
  limit: s.integer({ min: 1 }).nullable().optional(),
});

test("validates a correct value and infers its type", () => {
  const value = { files: [{ path: "common.json", content: "{}" }], dryRun: true };
  const result = validate(Upload, value);
  expect(result).toStrictEqual({ ok: true, value });
  if (result.ok) {
    const typed: Infer<typeof Upload> = result.value;
    const path: string = typed.files[0].path;
    const dryRun: boolean | undefined = typed.dryRun;
    expect([path, dryRun]).toStrictEqual(["common.json", true]);
  }
});

test("reports precise paths", () => {
  const result = validate(Upload, {
    files: [{ path: "", content: 1 }, { path: "a.json" }],
    extra: true,
    mode: "other",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues).toStrictEqual([
      { path: ["files", 0, "path"], message: "must not be empty" },
      { path: ["files", 0, "content"], message: "must be a string, not a number" },
      { path: ["files", 1, "content"], message: "is required" },
      { path: ["mode"], message: 'must be one of "full", "partial"' },
      { path: ["extra"], message: "is not a known property" },
    ]);
  }
});

test("optional, nullable and strip", () => {
  expect(validate(Upload, { files: [{ path: "a", content: "" }], limit: null }).ok).toStrictEqual(
    true,
  );
  expect(validate(Upload, { files: [{ path: "a", content: "" }], limit: 0 }).ok).toStrictEqual(
    false,
  );
  const Loose = s.object({ a: s.string() }, { unknown: "strip" });
  expect(parse(Loose, { a: "x", b: 1 })).toStrictEqual({ a: "x" });
});

test("records, unions, literals and refinements", () => {
  const Forms = s.record(s.string(), {
    key: s.enum(["zero", "one", "two", "few", "many", "other"]),
  });
  expect(validate(Forms, { one: "a", other: "b" }).ok).toBe(true);
  const bad = validate(Forms, { plural: "a" });
  expect(bad.ok).toBe(false);
  const Value = s.union([s.string(), Forms]);
  expect(parse(Value, "x")).toBe("x");
  expect(parse(Value, { other: "y" })).toStrictEqual({ other: "y" });
  const nested = validate(Value, { other: 3 });
  expect(nested.ok ? [] : nested.issues).toStrictEqual([
    { path: ["other"], message: "must be a string, not a number" },
  ]);
  const Even = s.refine(s.integer(), (n) => (n % 2 === 0 ? undefined : "must be even"));
  expect(validate(Even, 3)).toStrictEqual({
    ok: false,
    issues: [{ path: [], message: "must be even" }],
  });
  expect(parse(s.literal(1), 1)).toBe(1);
  expect(validate(s.array(s.string(), { unique: true }), ["a", "a"]).ok).toBe(false);
});

test("parse throws a SchemaError with a readable message", async () => {
  const error = await Promise.try(() => parse(Upload, { files: [] })).catch(
    (error: unknown) => error,
  );
  assert(error instanceof SchemaError);
  expect(error.message).toBe("files: must not be empty");
  expect(formatPath(["files", 0, "a-b", "c"])).toBe('files[0]["a-b"].c');
});

test("emits JSON Schema", () => {
  const schema = toJsonSchema(Upload, { id: "https://example.com/upload.json" });
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(schema.$id).toBe("https://example.com/upload.json");
  expect(schema.required).toStrictEqual(["files"]);
  expect(schema.additionalProperties).toBe(false);
  const files = (schema.properties as Record<string, Record<string, unknown>>).files;
  expect(files.minItems).toBe(1);
  const item = files.items as Record<string, Record<string, Record<string, unknown>>>;
  expect(item.properties.path).toStrictEqual({
    type: "string",
    minLength: 1,
    description: "Path below the source folder",
  });
  const limit = (schema.properties as Record<string, unknown>).limit;
  expect(limit).toStrictEqual({ anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] });
});

test("partial and extend", () => {
  const Settings = s.object({ name: s.string(), languages: s.array(s.string()) });
  const Patch = Settings.partial();
  expect(parse(Patch, {})).toStrictEqual({});
  expect(parse(Patch, { name: "x" })).toStrictEqual({ name: "x" });
  const More = Settings.extend({ extra: s.boolean() });
  expect(validate(More, { name: "a", languages: [], extra: true }).ok).toBe(true);
});
