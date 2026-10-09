// SPDX-License-Identifier: MIT
/**
 * The documentation's sidebar: groups of Markdown files in docs/, in reading order. Each
 * page is listed by its path relative to docs/ and named by its first heading.
 *
 * Every page in docs/ must appear here exactly once: the build fails otherwise, so a new
 * page can't end up unreachable from the sidebar.
 */
export interface NavigationGroup {
  title: string;
  sources: string[];
}

export const NAVIGATION: NavigationGroup[] = [
  { title: "Get started", sources: ["README.md"] },
  {
    title: "Host Quaso",
    sources: ["deploy-docker.md", "deploy-cloudflare.md", "operations.md"],
  },
  {
    title: "Translate your game",
    sources: [
      "add-to-your-game.md",
      "workflow.md",
      "website.md",
      "migrate-from-crowdin.md",
      "move-from-crowdin.md",
    ],
  },
  { title: "Reference", sources: ["cli.md", "configuration.md", "api.md"] },
  {
    title: "Contribute",
    sources: [
      "contributing/architecture.md",
      "contributing/testing.md",
      "contributing/cloudflare.md",
      "contributing/design-system.md",
      "releasing.md",
    ],
  },
];
