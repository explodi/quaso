// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
export function encodeBase64Url(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}
export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value) || value.length % 4 === 1)
    throw new TypeError("Invalid base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}
export function encodeHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
