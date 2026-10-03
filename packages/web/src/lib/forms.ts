// SPDX-License-Identifier: MIT
/** The API's schemas also validate browser forms, with the same field paths. */
import { type Schema, validate } from "@quaso/core";
import { ApiError } from "./api.ts";

export function validated<T>(schema: Schema<T>, value: unknown): T {
  const result = validate(schema, value);
  if (result.ok) return result.value;
  throw new ApiError(422, "validation_failed", "Check the highlighted fields.", {
    details: result.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export function fieldError(error: unknown, path: string): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return (
    error.details
      .filter((issue) => issue.path === path || issue.path?.startsWith(`${path}.`))
      .map((issue) => issue.message)
      .join("; ") || undefined
  );
}
