// SPDX-License-Identifier: MIT
export class StoreConflict extends Error {
  constructor() {
    super("The object changed before it could be written.");
    this.name = "StoreConflict";
  }
}

/** R2 keys are nonempty UTF-8 strings of at most 1,024 bytes. */
export function validateStoreKey(key: string): void {
  if (typeof key !== "string") throw new TypeError("An object key must be a string.");
  const bytes = new TextEncoder().encode(key);
  const validUnicode = new TextDecoder().decode(bytes) === key;
  const validLength = bytes.length > 0 && bytes.length <= 1024;
  if (!validUnicode || !validLength) {
    throw new RangeError("An object key must contain 1–1,024 UTF-8 bytes.");
  }
}

export function checkStoreCondition(
  current: string | undefined,
  ifMatch: string | undefined,
): void {
  if (ifMatch === undefined) return;
  const matches = ifMatch === "absent" ? current === undefined : current === ifMatch;
  if (!matches) throw new StoreConflict();
}
