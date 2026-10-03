// SPDX-License-Identifier: MIT
/**
 * @module
 * Quaso's core library: i18next files and quality, with no I/O. The service, the server,
 * the CLI and the website all use it (design §3, §5.1).
 */
export * from "./src/types.ts";
export * from "./src/schema.ts";
export * from "./src/json.ts";
export * from "./src/tokens.ts";
export * from "./src/plurals.ts";
export * from "./src/entries.ts";
export * from "./src/render.ts";
export * from "./src/checks.ts";
export * from "./src/text.ts";
export * from "./src/language_catalog.ts";
export * from "./src/hash.ts";
export * from "./src/config.ts";
export * from "./src/api.ts";
export * from "./src/glossary.ts";
export * from "./src/version.ts";

/** The callable fetch API, independent of runtime-specific helpers. */
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
