// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertThrows } from "@quaso/runtime/assert";
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
  assertEquals(result, { ok: true, value });
  if (result.ok) {
    const typed: Infer<typeof Upload> = result.value;
    const path: string = typed.files[0].path;
    const dryRun: boolean | undefined = typed.dryRun;
    assertEquals([path, dryRun], ["common.json", true]);
  }
});

test("reports precise paths", () => {
  const result = validate(Upload, {
    files: [{ path: "", content: 1 }, { path: "a.json" }],
    extra: true,
    mode: "other",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.issues, [
      { path: ["files", 0, "path"], message: "must not be empty" },
      { path: ["files", 0, "content"], message: "must be a string, not a number" },
      { path: ["files", 1, "content"], message: "is required" },
      { path: ["mode"], message: 'must be one of "full", "partial"' },
      { path: ["extra"], message: "is not a known property" },
    ]);
  }
});

test("optional, nullable and strip", () => {
  assertEquals(validate(Upload, { files: [{ path: "a", content: "" }], limit: null }).ok, true);
  assertEquals(validate(Upload, { files: [{ path: "a", content: "" }], limit: 0 }).ok, false);
  const Loose = s.object({ a: s.string() }, { unknown: "strip" });
  assertEquals(parse(Loose, { a: "x", b: 1 }), { a: "x" });
});

test("records, unions, literals and refinements", () => {
  const Forms = s.record(s.string(), {
    key: s.enum(["zero", "one", "two", "few", "many", "other"]),
  });
  assertEquals(validate(Forms, { one: "a", other: "b" }).ok, true);
  const bad = validate(Forms, { plural: "a" });
  assertEquals(bad.ok, false);
  const Value = s.union([s.string(), Forms]);
  assertEquals(parse(Value, "x"), "x");
  assertEquals(parse(Value, { other: "y" }), { other: "y" });
  const nested = validate(Value, { other: 3 });
  assertEquals(nested.ok ? [] : nested.issues, [
    { path: ["other"], message: "must be a string, not a number" },
  ]);
  const Even = s.refine(s.integer(), (n) => (n % 2 === 0 ? undefined : "must be even"));
  assertEquals(validate(Even, 3), { ok: false, issues: [{ path: [], message: "must be even" }] });
  assertEquals(parse(s.literal(1), 1), 1);
  assertEquals(validate(s.array(s.string(), { unique: true }), ["a", "a"]).ok, false);
});

test("parse throws a SchemaError with a readable message", () => {
  const error = assertThrows(() => parse(Upload, { files: [] }), SchemaError);
  assertEquals(error.message, "files: must not be empty");
  assertEquals(formatPath(["files", 0, "a-b", "c"]), 'files[0]["a-b"].c');
});

test("emits JSON Schema", () => {
  const schema = toJsonSchema(Upload, { id: "https://example.com/upload.json" });
  assertEquals(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assertEquals(schema.$id, "https://example.com/upload.json");
  assertEquals(schema.required, ["files"]);
  assertEquals(schema.additionalProperties, false);
  const files = (schema.properties as Record<string, Record<string, unknown>>).files;
  assertEquals(files.minItems, 1);
  const item = files.items as Record<string, Record<string, Record<string, unknown>>>;
  assertEquals(item.properties.path, {
    type: "string",
    minLength: 1,
    description: "Path below the source folder",
  });
  const limit = (schema.properties as Record<string, unknown>).limit;
  assertEquals(limit, { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] });
});

test("partial and extend", () => {
  const Settings = s.object({ name: s.string(), languages: s.array(s.string()) });
  const Patch = Settings.partial();
  assertEquals(parse(Patch, {}), {});
  assertEquals(parse(Patch, { name: "x" }), { name: "x" });
  const More = Settings.extend({ extra: s.boolean() });
  assertEquals(validate(More, { name: "a", languages: [], extra: true }).ok, true);
});
