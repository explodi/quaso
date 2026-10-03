// SPDX-License-Identifier: MIT
import { strict as nodeAssert } from "node:assert";
export const assert: typeof nodeAssert.ok = nodeAssert.ok;
export const assertEquals: typeof nodeAssert.deepEqual = nodeAssert.deepEqual;
export const assertNotEquals: typeof nodeAssert.notDeepEqual = nodeAssert.notDeepEqual;
export const assertStrictEquals: typeof nodeAssert.equal = nodeAssert.equal;
export const assertMatch: typeof nodeAssert.match = nodeAssert.match;
export function assertFalse(value: unknown, message?: string): asserts value is false {
  nodeAssert.equal(value, false, message ?? "Expected false");
}
export function assertStringIncludes(actual: string, expected: string, message?: string): void {
  nodeAssert.ok(
    actual.includes(expected),
    message ?? `${JSON.stringify(actual)} does not include ${JSON.stringify(expected)}`,
  );
}
export function assertInstanceOf<T>(
  value: unknown,
  Class: new (...args: any[]) => T,
  message?: string,
): asserts value is T {
  nodeAssert.ok(value instanceof Class, message ?? `Expected ${Class.name}`);
}
function checkError<E extends Error>(
  error: unknown,
  Class?: new (...args: any[]) => E,
  includes?: string,
  _message?: string,
): E {
  if (Class) assertInstanceOf(error, Class);
  else assertInstanceOf(error, Error);
  if (includes) assertStringIncludes((error as Error).message, includes);
  return error as E;
}
export function assertThrows<E extends Error = Error>(
  fn: () => unknown,
  Class?: new (...args: any[]) => E,
  includes?: string,
  _message?: string,
): E {
  try {
    fn();
  } catch (error) {
    return checkError(error, Class, includes);
  }
  throw new nodeAssert.AssertionError({ message: "Expected function to throw" });
}
export async function assertRejects<E extends Error = Error>(
  fn: () => Promise<unknown>,
  Class?: new (...args: any[]) => E,
  includes?: string,
  _message?: string,
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    return checkError(error, Class, includes);
  }
  throw new nodeAssert.AssertionError({ message: "Expected promise to reject" });
}
