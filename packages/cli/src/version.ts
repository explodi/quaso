// SPDX-License-Identifier: MIT
import { VERSION } from "@quaso/core";

/** The version checked against the published package metadata by build_cli.ts. */
export { VERSION };
/** The User-Agent header of every request. */
export const USER_AGENT = `quaso-cli/${VERSION}`;
