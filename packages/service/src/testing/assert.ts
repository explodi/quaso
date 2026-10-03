// SPDX-License-Identifier: MIT
/**
 * A tiny assertion helper for the shared test cases, which also run in `workerd` (Sprint 3)
 * where `@std/assert` isn't available. Plain data only: objects, arrays, bytes and primitives.
 */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/** Fails unless `value` is truthy. */
export function check(value: unknown, message = "Expected a truthy value"): asserts value {
  if (!value) throw new AssertionError(message);
}

/** Fails unless `actual` and `expected` are deeply equal. */
export function checkEqual(actual: unknown, expected: unknown, message?: string): void {
  if (!deepEqual(actual, expected)) {
    const prefix = message ? `${message}: ` : "";
    throw new AssertionError(`${prefix}expected ${show(expected)}, got ${show(actual)}`);
  }
}

/** Fails unless `fn` throws; returns the error. */
export function checkThrows(fn: () => unknown, message = "Expected an error"): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new AssertionError(message);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) {
      return false;
    }
    return a.every((byte, i) => byte === b[i]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    const recordA = a as Record<string, unknown>;
    const recordB = b as Record<string, unknown>;
    return keysA.every(
      (key) => Object.hasOwn(recordB, key) && deepEqual(recordA[key], recordB[key]),
    );
  }
  return false;
}

function show(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array [${Array.from(value).join(", ")}]`;
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
