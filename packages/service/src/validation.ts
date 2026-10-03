// SPDX-License-Identifier: MIT
/**
 * Input validation with core's schemas. The internal HTTP API passes inputs through, so the
 * service validates every input itself, and reports each problem with its path.
 */
import { formatPath, Id, type Issue, type IssuePath, s, type Schema, validate } from "@quaso/core";
import type { Actor } from "./api.ts";
import { ServiceError } from "./errors.ts";

const ActorSchema = s.union([
  s.object({ type: s.literal("anonymous") }, { unknown: "strip" }),
  s.object({ type: s.literal("system") }, { unknown: "strip" }),
  s.object({ type: s.literal("user"), userId: Id }, { unknown: "strip" }),
  s.object({ type: s.literal("token"), tokenId: Id }, { unknown: "strip" }),
]);

export function validateActor(input: unknown): Actor {
  return validateInput(ActorSchema, input);
}

/**
 * Checks an input against its schema; `validation_failed` with the paths otherwise. Whole
 * numbers must also be exact (at most 2^53 - 1), since larger ones can't be stored and read
 * back, whatever the schema allows.
 */
export function validateInput<T>(schema: Schema<T>, input: unknown): T {
  const result = validate(schema, input ?? {});
  if (!result.ok) throw validationFailed(result.issues);
  const inexact = inexactIntegers(result.value, []);
  if (inexact.length > 0) throw validationFailed(inexact);
  return result.value;
}

/** Issues for the whole numbers in a value that aren't safe integers. */
function inexactIntegers(value: unknown, path: IssuePath): Issue[] {
  if (typeof value === "number") {
    return Number.isInteger(value) && !Number.isSafeInteger(value)
      ? [{ path, message: `must be at most ${Number.MAX_SAFE_INTEGER}` }]
      : [];
  }
  if (typeof value !== "object" || value === null) return [];
  const issues: Issue[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") continue;
    issues.push(...inexactIntegers(item, [...path, Array.isArray(value) ? Number(key) : key]));
  }
  return issues;
}

/** The `validation_failed` error for schema issues. */
export function validationFailed(issues: readonly Issue[]): ServiceError {
  const first = issues[0];
  const where = first && first.path.length > 0 ? `${formatPath(first.path)}: ` : "";
  const message = first ? `The request is invalid: ${where}${first.message}.` : "Invalid request.";
  return new ServiceError("validation_failed", message, {
    details: issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
  });
}
