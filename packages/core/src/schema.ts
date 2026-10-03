// SPDX-License-Identifier: MIT
/**
 * A small schema module (design §5.1): declare a schema once, and get a validator with
 * precise error paths, a TypeScript type (`Infer<typeof schema>`) and a JSON Schema.
 *
 * ```ts
 * const Upload = s.object({
 *   files: s.array(s.object({ path: s.string({ minLength: 1 }), content: s.string() })),
 *   dryRun: s.boolean().optional(),
 * });
 * type Upload = Infer<typeof Upload>;
 * const result = validate(Upload, JSON.parse(body));
 * ```
 *
 * Objects reject unknown properties by default, so typos in config files and requests
 * are reported instead of ignored.
 */

/** A path into a value: object keys and array indices. */
export type IssuePath = (string | number)[];

/** One validation problem. */
export interface Issue {
  path: IssuePath;
  message: string;
}

/** The result of `validate()`. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

/** A JSON Schema document (draft 2020-12), as plain data. */
export type JsonSchema = { [key: string]: unknown };

/** Thrown by `parse()` when a value doesn't match its schema. */
export class SchemaError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map(formatIssue).join("; "));
    this.name = "SchemaError";
    this.issues = issues;
  }
}

/** Formats an issue as `path.to.value: message`, or just the message at the root. */
export function formatIssue(issue: Issue): string {
  return issue.path.length === 0 ? issue.message : `${formatPath(issue.path)}: ${issue.message}`;
}

/** Formats a path as `files[0].path`. */
export function formatPath(path: IssuePath): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) out += out === "" ? part : `.${part}`;
    else out += `[${JSON.stringify(part)}]`;
  }
  return out;
}

const INVALID: unique symbol = Symbol("invalid");
type Invalid = typeof INVALID;

interface Context {
  issues: Issue[];
}

/** The base of every schema. `T` is the type of a valid value. */
export abstract class Schema<T> {
  /** Only used for type inference; never set at runtime. */
  declare readonly _type: T;
  description?: string;

  /** Checks `value` and returns it (possibly copied), or `INVALID` after recording issues. */
  abstract check(value: unknown, path: IssuePath, context: Context): T | Invalid;

  /** This schema as JSON Schema, without `$schema`. */
  abstract toJsonSchema(): JsonSchema;

  /** Adds a description, used in the JSON Schema and the OpenAPI document. */
  describe(description: string): this {
    const copy = Object.create(Object.getPrototypeOf(this));
    Object.assign(copy, this);
    copy.description = description;
    return copy;
  }

  /** The property may be missing (or `undefined`). */
  optional(): OptionalSchema<T> {
    return new OptionalSchema(this);
  }

  /** The value may be `null`. */
  nullable(): Schema<T | null> {
    return new NullableSchema(this);
  }

  protected withDescription(schema: JsonSchema): JsonSchema {
    return this.description ? { ...schema, description: this.description } : schema;
  }
}

/** The type of a valid value of a schema. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

function issue(context: Context, path: IssuePath, message: string): Invalid {
  context.issues.push({ path: [...path], message });
  return INVALID;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return Number.isFinite(value) ? "a number" : String(value);
  if (typeof value === "boolean") return "a boolean";
  return typeof value;
}

// ---------------------------------------------------------------------------------------
// Primitives

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  /** Shown in messages when the pattern doesn't match, such as "a language tag". */
  patternName?: string;
  /** A JSON Schema format, such as "email" or "uri". Informational only. */
  format?: string;
}

export class StringSchema extends Schema<string> {
  constructor(readonly options: StringOptions = {}) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): string | Invalid {
    if (typeof value !== "string") {
      return issue(context, path, `must be a string, not ${describeType(value)}`);
    }
    const { minLength, maxLength, pattern, patternName } = this.options;
    if (minLength !== undefined && value.length < minLength) {
      return issue(
        context,
        path,
        minLength === 1 ? "must not be empty" : `must have at least ${minLength} characters`,
      );
    }
    if (maxLength !== undefined && value.length > maxLength) {
      return issue(context, path, `must have at most ${maxLength} characters`);
    }
    if (pattern && !pattern.test(value)) {
      return issue(context, path, patternName ? `must be ${patternName}` : `must match ${pattern}`);
    }
    return value;
  }
  toJsonSchema(): JsonSchema {
    const { minLength, maxLength, pattern, format } = this.options;
    const schema: JsonSchema = { type: "string" };
    if (minLength !== undefined) schema.minLength = minLength;
    if (maxLength !== undefined) schema.maxLength = maxLength;
    if (pattern) schema.pattern = pattern.source;
    if (format) schema.format = format;
    return this.withDescription(schema);
  }
}

export interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
}

export class NumberSchema extends Schema<number> {
  constructor(readonly options: NumberOptions = {}) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): number | Invalid {
    const { min, max, integer } = this.options;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return issue(
        context,
        path,
        `must be ${integer ? "an integer" : "a number"}, not ${describeType(value)}`,
      );
    }
    if (integer && !Number.isInteger(value)) return issue(context, path, "must be an integer");
    if (min !== undefined && value < min) return issue(context, path, `must be at least ${min}`);
    if (max !== undefined && value > max) return issue(context, path, `must be at most ${max}`);
    return value;
  }
  toJsonSchema(): JsonSchema {
    const { min, max, integer } = this.options;
    const schema: JsonSchema = { type: integer ? "integer" : "number" };
    if (min !== undefined) schema.minimum = min;
    if (max !== undefined) schema.maximum = max;
    return this.withDescription(schema);
  }
}

export class BooleanSchema extends Schema<boolean> {
  check(value: unknown, path: IssuePath, context: Context): boolean | Invalid {
    if (typeof value !== "boolean") {
      return issue(context, path, `must be true or false, not ${describeType(value)}`);
    }
    return value;
  }
  toJsonSchema(): JsonSchema {
    return this.withDescription({ type: "boolean" });
  }
}

type Literal = string | number | boolean | null;

export class LiteralSchema<T extends Literal> extends Schema<T> {
  constructor(readonly value: T) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): T | Invalid {
    if (value !== this.value) return issue(context, path, `must be ${JSON.stringify(this.value)}`);
    return value as T;
  }
  toJsonSchema(): JsonSchema {
    return this.withDescription({ const: this.value });
  }
}

export class EnumSchema<T extends string> extends Schema<T> {
  constructor(readonly values: readonly T[]) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): T | Invalid {
    if (typeof value !== "string" || !(this.values as readonly string[]).includes(value)) {
      const list = this.values.map((v) => JSON.stringify(v)).join(", ");
      return issue(context, path, `must be one of ${list}`);
    }
    return value as T;
  }
  toJsonSchema(): JsonSchema {
    return this.withDescription({ type: "string", enum: [...this.values] });
  }
}

/** Accepts anything that is valid JSON data. */
export class UnknownSchema extends Schema<unknown> {
  check(value: unknown): unknown {
    return value;
  }
  toJsonSchema(): JsonSchema {
    return this.withDescription({});
  }
}

// ---------------------------------------------------------------------------------------
// Modifiers

export class OptionalSchema<T> extends Schema<T | undefined> {
  readonly isOptional = true;
  constructor(readonly inner: Schema<T>) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): T | undefined | Invalid {
    if (value === undefined) return undefined;
    return this.inner.check(value, path, context);
  }
  toJsonSchema(): JsonSchema {
    const schema = this.inner.toJsonSchema();
    return this.description ? { ...schema, description: this.description } : schema;
  }
}

export class NullableSchema<T> extends Schema<T | null> {
  constructor(readonly inner: Schema<T>) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): T | null | Invalid {
    if (value === null) return null;
    return this.inner.check(value, path, context);
  }
  toJsonSchema(): JsonSchema {
    return this.withDescription({ anyOf: [this.inner.toJsonSchema(), { type: "null" }] });
  }
}

// ---------------------------------------------------------------------------------------
// Containers

export interface ArrayOptions {
  minItems?: number;
  maxItems?: number;
  /** Items must be distinct (compared as JSON). */
  unique?: boolean;
}

export class ArraySchema<T> extends Schema<T[]> {
  constructor(
    readonly item: Schema<T>,
    readonly options: ArrayOptions = {},
  ) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): T[] | Invalid {
    if (!Array.isArray(value)) {
      return issue(context, path, `must be an array, not ${describeType(value)}`);
    }
    const { minItems, maxItems, unique } = this.options;
    if (minItems !== undefined && value.length < minItems) {
      return issue(
        context,
        path,
        minItems === 1 ? "must not be empty" : `must have at least ${minItems} items`,
      );
    }
    if (maxItems !== undefined && value.length > maxItems) {
      return issue(context, path, `must have at most ${maxItems} items`);
    }
    const out: T[] = [];
    let invalid = false;
    const seen = new Set<string>();
    value.forEach((item, index) => {
      const checked = this.item.check(item, [...path, index], context);
      if (checked === INVALID) {
        invalid = true;
        return;
      }
      if (unique) {
        const key = JSON.stringify(checked);
        if (seen.has(key)) {
          issue(context, [...path, index], "is a duplicate");
          invalid = true;
        }
        seen.add(key);
      }
      out.push(checked);
    });
    return invalid ? INVALID : out;
  }
  toJsonSchema(): JsonSchema {
    const { minItems, maxItems, unique } = this.options;
    const schema: JsonSchema = { type: "array", items: this.item.toJsonSchema() };
    if (minItems !== undefined) schema.minItems = minItems;
    if (maxItems !== undefined) schema.maxItems = maxItems;
    if (unique) schema.uniqueItems = true;
    return this.withDescription(schema);
  }
}
type AnySchema = Schema<any>;
type Shape = Record<string, AnySchema>;
type OptionalKeys<P extends Shape> = {
  [K in keyof P]: P[K] extends OptionalSchema<unknown> ? K : never;
}[keyof P];
type RequiredKeys<P extends Shape> = Exclude<keyof P, OptionalKeys<P>>;
type Simplify<T> = { [K in keyof T]: T[K] } & unknown;
/** The type of a valid value of an object schema's shape. */
export type ObjectType<P extends Shape> = Simplify<
  { [K in RequiredKeys<P>]: Infer<P[K]> } & {
    [K in OptionalKeys<P>]?: Exclude<Infer<P[K]>, undefined>;
  }
>;

export interface ObjectOptions {
  /** What to do with properties the shape doesn't declare. Default: "reject". */
  unknown?: "reject" | "strip";
}

export class ObjectSchema<P extends Shape> extends Schema<ObjectType<P>> {
  constructor(
    readonly shape: P,
    readonly options: ObjectOptions = {},
  ) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): ObjectType<P> | Invalid {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return issue(context, path, `must be an object, not ${describeType(value)}`);
    }
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let invalid = false;
    for (const [key, schema] of Object.entries(this.shape)) {
      const present = Object.hasOwn(input, key) && input[key] !== undefined;
      if (!present) {
        if (schema instanceof OptionalSchema) continue;
        issue(context, [...path, key], "is required");
        invalid = true;
        continue;
      }
      const checked = schema.check(input[key], [...path, key], context);
      if (checked === INVALID) invalid = true;
      else if (checked !== undefined) out[key] = checked;
    }
    if ((this.options.unknown ?? "reject") === "reject") {
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(this.shape, key)) {
          issue(context, [...path, key], "is not a known property");
          invalid = true;
        }
      }
    }
    return invalid ? INVALID : (out as ObjectType<P>);
  }
  toJsonSchema(): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, schema] of Object.entries(this.shape)) {
      properties[key] = schema.toJsonSchema();
      if (!(schema instanceof OptionalSchema)) required.push(key);
    }
    const schema: JsonSchema = { type: "object", properties };
    if (required.length > 0) schema.required = required;
    if ((this.options.unknown ?? "reject") === "reject") schema.additionalProperties = false;
    return this.withDescription(schema);
  }
  /** A copy with more properties. */
  extend<Q extends Shape>(shape: Q): ObjectSchema<Omit<P, keyof Q> & Q> {
    return new ObjectSchema({ ...this.shape, ...shape } as Omit<P, keyof Q> & Q, this.options);
  }
  /** A copy where every property is optional, for PATCH requests. */
  partial(): ObjectSchema<{ [K in keyof P]: OptionalSchema<Infer<P[K]>> }> {
    const shape: Record<string, AnySchema> = {};
    for (const [key, schema] of Object.entries(this.shape)) {
      shape[key] = schema instanceof OptionalSchema ? schema : schema.optional();
    }
    return new ObjectSchema(shape as { [K in keyof P]: OptionalSchema<Infer<P[K]>> }, this.options);
  }
}

export interface RecordOptions {
  /** A schema the keys must match. */
  key?: StringSchema | EnumSchema<string>;
}

export class RecordSchema<T> extends Schema<Record<string, T>> {
  constructor(
    readonly value: Schema<T>,
    readonly options: RecordOptions = {},
  ) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): Record<string, T> | Invalid {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return issue(context, path, `must be an object, not ${describeType(value)}`);
    }
    const out: Record<string, T> = {};
    let invalid = false;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (this.options.key) {
        const keyContext: Context = { issues: [] };
        if (this.options.key.check(key, [...path, key], keyContext) === INVALID) {
          issue(context, [...path, key], `is not an allowed key (${keyContext.issues[0].message})`);
          invalid = true;
          continue;
        }
      }
      const checked = this.value.check(item, [...path, key], context);
      if (checked === INVALID) invalid = true;
      else out[key] = checked;
    }
    return invalid ? INVALID : out;
  }
  toJsonSchema(): JsonSchema {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: this.value.toJsonSchema(),
    };
    if (this.options.key) schema.propertyNames = this.options.key.toJsonSchema();
    return this.withDescription(schema);
  }
}

type UnionType<S extends readonly AnySchema[]> = Infer<S[number]>;

/** The first matching alternative wins. Issues come from the closest alternative. */
export class UnionSchema<S extends readonly AnySchema[]> extends Schema<UnionType<S>> {
  constructor(readonly alternatives: S) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): UnionType<S> | Invalid {
    let best: Issue[] | undefined;
    for (const alternative of this.alternatives) {
      const attempt: Context = { issues: [] };
      const checked = alternative.check(value, path, attempt);
      if (checked !== INVALID) return checked;
      // Prefer the alternative that got furthest into the value.
      const depth = Math.max(...attempt.issues.map((i) => i.path.length));
      const bestDepth = best ? Math.max(...best.map((i) => i.path.length)) : -1;
      if (!best || depth > bestDepth) best = attempt.issues;
    }
    if (best && best.some((i) => i.path.length > path.length)) {
      context.issues.push(...best);
      return INVALID;
    }
    return issue(context, path, "doesn't match any of the allowed forms");
  }
  toJsonSchema(): JsonSchema {
    return this.withDescription({ anyOf: this.alternatives.map((a) => a.toJsonSchema()) });
  }
}

/** A schema with an extra check, such as "a valid language tag". */
export class RefinedSchema<T> extends Schema<T> {
  constructor(
    readonly inner: Schema<T>,
    readonly refine: (value: T) => string | undefined,
  ) {
    super();
  }
  check(value: unknown, path: IssuePath, context: Context): T | Invalid {
    const checked = this.inner.check(value, path, context);
    if (checked === INVALID) return INVALID;
    const problem = this.refine(checked);
    return problem ? issue(context, path, problem) : checked;
  }
  toJsonSchema(): JsonSchema {
    const schema = this.inner.toJsonSchema();
    return this.description ? { ...schema, description: this.description } : schema;
  }
}

// ---------------------------------------------------------------------------------------
// Builders

/** Schema builders. */
export const s = {
  string: (options?: StringOptions): StringSchema => new StringSchema(options),
  number: (options?: NumberOptions): NumberSchema => new NumberSchema(options),
  integer: (options?: Omit<NumberOptions, "integer">): NumberSchema =>
    new NumberSchema({ ...options, integer: true }),
  boolean: (): BooleanSchema => new BooleanSchema(),
  literal: <T extends Literal>(value: T): LiteralSchema<T> => new LiteralSchema(value),
  enum: <const T extends string>(values: readonly T[]): EnumSchema<T> => new EnumSchema(values),
  unknown: (): UnknownSchema => new UnknownSchema(),
  array: <T>(item: Schema<T>, options?: ArrayOptions): ArraySchema<T> =>
    new ArraySchema(item, options),
  object: <P extends Shape>(shape: P, options?: ObjectOptions): ObjectSchema<P> =>
    new ObjectSchema(shape, options),
  record: <T>(value: Schema<T>, options?: RecordOptions): RecordSchema<T> =>
    new RecordSchema(value, options),
  union: <const S extends readonly AnySchema[]>(alternatives: S): UnionSchema<S> =>
    new UnionSchema(alternatives),
  refine: <T>(inner: Schema<T>, check: (value: T) => string | undefined): RefinedSchema<T> =>
    new RefinedSchema(inner, check),
};

// ---------------------------------------------------------------------------------------
// Using schemas

/** Checks a value against a schema. */
export function validate<T>(schema: Schema<T>, value: unknown): ValidationResult<T> {
  const context: Context = { issues: [] };
  const checked = schema.check(value, [], context);
  if (checked === INVALID || context.issues.length > 0) {
    return { ok: false, issues: context.issues };
  }
  return { ok: true, value: checked };
}

/** Checks a value against a schema, and throws a `SchemaError` if it doesn't match. */
export function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = validate(schema, value);
  if (!result.ok) throw new SchemaError(result.issues);
  return result.value;
}

/** A complete JSON Schema document for a schema. */
export function toJsonSchema(
  schema: AnySchema,
  options: { id?: string; title?: string } = {},
): JsonSchema {
  const document: JsonSchema = { $schema: "https://json-schema.org/draft/2020-12/schema" };
  if (options.id) document.$id = options.id;
  if (options.title) document.title = options.title;
  return { ...document, ...schema.toJsonSchema() };
}
