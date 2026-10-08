// SPDX-License-Identifier: MIT
import workspace from "../../../package.json" with { type: "json" };

/**
 * The version of every package and artifact (the server, the image, the CLI, the website):
 * the repository's package.json. scripts/release.ts changes it there and nowhere else.
 */
export const VERSION: string = workspace.version;
