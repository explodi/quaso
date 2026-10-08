// SPDX-License-Identifier: MIT
/**
 * Where the site's pages live, and how they link to each other.
 *
 * Output paths are relative to the site's root, with forward slashes: `index.html`,
 * `docs/index.html`, `docs/contributing/architecture.html`. Every link between pages is
 * relative, so the site works at any address: `https://example.com/` as well as
 * `https://<org>.github.io/quaso/`.
 *
 * Shared by the pre-renderer (build.ts) and the pages, so that links always match the
 * files the build writes. It runs in Deno and in the browser: no Deno or Node APIs.
 */

/** The landing page. */
export const HOME = "index.html";

/** The documentation's index page, rendered from docs/README.md. */
export const DOCS_HOME = "docs/index.html";

/**
 * The page a Markdown file in docs/ becomes, from its path relative to docs/:
 * `README.md` becomes `docs/index.html` and `contributing/architecture.md` becomes
 * `docs/contributing/architecture.html`.
 */
export function docPagePath(source: string): string {
  const html = source.replace(/(^|\/)README\.md$/i, "$1index.html").replace(/\.md$/i, ".html");
  return `docs/${html}`;
}

/**
 * A relative link from the page at `from` to the file at `to`, both output paths.
 * Index pages are linked as their folder (`../`, `docs/`), the way web servers serve them.
 */
export function relativeHref(from: string, to: string): string {
  const fromFolders = from.split("/").slice(0, -1);
  const target =
    to === "index.html" || to.endsWith("/index.html") ? to.slice(0, -"index.html".length) : to;
  const toParts = target.split("/");
  let common = 0;
  while (
    common < fromFolders.length &&
    common < toParts.length - 1 &&
    fromFolders[common] === toParts[common]
  ) {
    common++;
  }
  const href = "../".repeat(fromFolders.length - common) + toParts.slice(common).join("/");
  return href === "" ? "./" : href;
}

/** The branch that the site is published from, for links to files on GitHub. */
export const BRANCH = "main";

/** A link to a file or folder of the repository on GitHub, from its path in the repository. */
export function repositoryFileUrl(repositoryUrl: string, path: string, folder = false): string {
  return `${repositoryUrl}/${folder ? "tree" : "blob"}/${BRANCH}/${encodeURI(path)}`;
}

/** The site's style sheet, from src/styles.css. */
export const SITE_CSS = "assets/site.css";

/** github-markdown-css's style sheet, for the Markdown on documentation pages. */
export const GFM_CSS = "assets/gfm.css";
