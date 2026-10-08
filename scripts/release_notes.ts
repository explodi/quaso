// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/** Print the tagged changelog section and the routine operator upgrade instructions. */
import { validateVersion } from "./release.ts";

export function releaseNotes(changelog: string, version: string, repository?: string): string {
  validateVersion(version);
  const sections = changelog.split(/^## /m);
  const section = sections.find((part) => part.startsWith(`[${version}] - `));
  if (!section || section.startsWith(`[${version}] - unreleased`)) {
    throw new Error(`No dated changelog section for ${version}`);
  }
  const operations = repository
    ? `https://github.com/${repository}/blob/v${version}/docs/operations.md`
    : "docs/operations.md";
  return (
    `## ${section.trim()}\n\n## Upgrading\n\n` +
    `Back up the instance and retain its SECRET_KEY and previous image before upgrading.\n\n` +
    `- Docker Compose: pin image version \`${version}\`, then run ` +
    "`docker compose pull` and `docker compose up -d`. Check `/healthz` and the logs.\n" +
    "- Cloudflare: deploy this source tag with `deno task cf:deploy --env production`, " +
    "then check `/healthz` and the jobs page.\n\n" +
    "Migrations are forward-only. Keep the pre-migration snapshot with the previous image. " +
    `Read [operations and rollback](${operations}) before changing production.\n`
  );
}

if (import.meta.main) {
  const version = process.env["RELEASE_VERSION"];
  if (!version) throw new Error("RELEASE_VERSION is required");
  console.log(
    releaseNotes(
      await fs.readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
      version,
      process.env["GITHUB_REPOSITORY"],
    ),
  );
}
