// SPDX-License-Identifier: MIT
/**
 * The Quaso server: the website's files and the HTTP API (design §3, §5.11), with local
 * storage. `quaso serve` runs it; `quaso help` lists the other commands.
 */
import { main } from "./src/commands.ts";

export { createApp } from "./src/app.ts";
export { VERSION } from "./src/version.ts";

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
