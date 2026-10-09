// SPDX-License-Identifier: MIT
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
/**
 * Builds the project website into site/dist/ (`deno task site:build`).
 *
 * Every page is pre-rendered to static HTML with react-dom/server (src/prerender.tsx), so
 * the pages load fast, work without JavaScript and ship none. That is also why there is no
 * `vite build` step: Vite only runs the development server (`deno task site`).
 *
 * - The landing page (src/Landing.tsx) becomes index.html.
 * - Each Markdown file in docs/ becomes a page, rendered with marked and Quaso’s documentation
 *   styles: docs/README.md becomes docs/index.html, docs/contributing/architecture.md becomes
 *   docs/contributing/architecture.html. Links to Markdown files in docs/ point to their
 *   pages; links to other files of the repository point to GitHub. Other files in docs/,
 *   such as images, are copied.
 * - The sidebar lists the pages in the groups of navigation.ts.
 * - A region between `<!-- tabs -->` and `<!-- /tabs -->` becomes tabs (see renderTabs).
 * - 404.html is the page GitHub Pages serves for missing addresses.
 *
 * Links between pages are relative, so the site works at any address, such as
 * `https://<org>.github.io/quaso/`. Only 404.html, which GitHub Pages serves at any
 * address, needs to know the site's path.
 *
 * Environment variables, all optional:
 * - `BASE_PATH`: the path the site is served under, such as `/quaso`, for 404.html.
 *   Default: `/`. The workflow passes the value from actions/configure-pages.
 * - `SITE_REPOSITORY_URL`: the repository on GitHub, for source links. Default: from
 *   GitHub Actions' variables, or from the git remote `origin`.
 */
import { marked } from "marked";
import { gfmHeadingId } from "marked-gfm-heading-id";
marked.use(gfmHeadingId());
const render = (text: string) => marked.parse(text, { async: false });
import { cp } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { walk } from "@std/fs/walk";
import { fileURLToPath as fromFileUrl } from "node:url";
import { dirname, join, relative, sep as SEPARATOR } from "node:path";
import * as posix from "node:path/posix";
import { bundleStylesheet } from "./styles.ts";
import { NAVIGATION, type NavigationGroup } from "./navigation.ts";
import type { DocGroup } from "./src/DocPage.tsx";
import { renderDoc, renderLanding, renderNotFound } from "./src/prerender.tsx";
import {
  docPagePath,
  DOCS_HOME,
  GFM_CSS,
  HOME,
  relativeHref,
  repositoryFileUrl,
  SITE_CSS,
} from "./src/paths.ts";

const SITE = fromFileUrl(new URL(".", import.meta.url));
const REPOSITORY = join(SITE, "..");
const DOCS = join(REPOSITORY, "docs");
const OUT = join(SITE, "dist");

/** What a path in the repository is, if it exists. */
export type PathKind = "file" | "folder" | undefined;

export interface LinkContext {
  /** The repository on GitHub, for links to files outside docs/. */
  repositoryUrl?: string;
  /** What a path in the repository (such as `docs/cli.md`) is, if it exists. */
  kind: (path: string) => PathKind;
  /** Reports a link that leads nowhere. */
  warn: (message: string) => void;
}

export interface LinkSource {
  /** The Markdown file, relative to docs/. */
  source: string;
  /** Its page's output path. */
  page: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

function unescapeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (entity) => ENTITIES[entity]);
}

function escapeAttribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/**
 * Where a link in a Markdown file of docs/ should point on the site. Returns the new
 * address, and the output path of the documentation page it leads to, if any.
 */
export function rewriteHref(
  href: string,
  from: LinkSource,
  context: LinkContext,
): { href: string; page?: string } {
  // Fragments, absolute URLs (https:, mailto:) and protocol-relative ones stay as they are.
  if (
    href === "" ||
    href.startsWith("#") ||
    href.startsWith("//") ||
    /^[a-z][\w+.-]*:/i.test(href)
  ) {
    return { href };
  }
  const [, rawPath, suffix] = /^([^?#]*)(.*)$/s.exec(href)!;
  if (rawPath === "") return { href };
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return { href };
  }
  // GitHub resolves links from the file's folder, or from the repository's root for `/…`.
  const joined = path.startsWith("/")
    ? posix.normalize(path.slice(1) || ".")
    : posix.join("docs", posix.dirname(from.source), path);
  const target = joined.replace(/\/+$/, "") || ".";
  if (target === ".." || target.startsWith("../")) return { href };
  const kind = context.kind(target);
  const where = `docs/${from.source}`;

  if (target === "docs" || target.startsWith("docs/")) {
    const inDocs = target.slice("docs/".length);
    let page: string | undefined;
    let output: string;
    if (/\.md$/i.test(inDocs)) {
      output = page = docPagePath(inDocs);
      if (kind !== "file") context.warn(`${where}: "${href}" leads to ${target}, which is missing`);
    } else if (kind === "folder" || path.endsWith("/")) {
      output = page = inDocs === "" ? DOCS_HOME : docPagePath(`${inDocs}/README.md`);
      if (inDocs !== "" && context.kind(`${target}/README.md`) !== "file") {
        context.warn(`${where}: "${href}" leads to ${target}/, which has no README.md`);
      }
    } else {
      output = target;
      if (kind === undefined) {
        context.warn(`${where}: "${href}" leads to ${target}, which is missing`);
      }
    }
    const rewritten = encodeURI(relativeHref(from.page, output)) + suffix;
    return page ? { href: rewritten, page } : { href: rewritten };
  }

  if (kind === undefined) context.warn(`${where}: "${href}" leads to ${target}, which is missing`);
  if (!context.repositoryUrl) {
    context.warn(`${where}: "${href}" leads outside docs/, and the repository's URL is unknown`);
    return { href };
  }
  if (target === ".") return { href: context.repositoryUrl + suffix };
  return { href: repositoryFileUrl(context.repositoryUrl, target, kind === "folder") + suffix };
}

/** Rewrites the links of a rendered Markdown file for the site. */
export function rewriteLinks(html: string, from: LinkSource, context: LinkContext): string {
  return html.replace(
    /(<a\s[^>]*?\bhref=")([^"]*)(")/g,
    (_match, before: string, value: string, after: string) =>
      before + escapeAttribute(rewriteHref(unescapeHtml(value), from, context).href) + after,
  );
}

/**
 * Turns each region of rendered Markdown between `<!-- tabs -->` and `<!-- /tabs -->` into
 * tabs: one per heading at the level of the region's first heading, named by the heading.
 * On GitHub, where comments are invisible, the region reads as one subsection per tab.
 *
 * The tabs are radio buttons, each followed by its label and its panel, so they work
 * without JavaScript: CSS shows the panel after the checked button.
 */
export function renderTabs(html: string): string {
  let group = 0;
  return html.replace(/<!-- tabs -->([\s\S]*?)<!-- \/tabs -->/g, (_region, content: string) => {
    group++;
    const level = /<h([1-6])\b/.exec(content)?.[1];
    const [before, ...sections] = content.split(new RegExp(`(?=<h${level}\\b)`));
    if (level === undefined || before.trim() !== "") {
      throw new Error("A tabs region must start with a heading for its first tab.");
    }
    const tabs = sections.map((section, index) => {
      const [, attributes, title, panel] = new RegExp(
        `^<h${level}([^>]*)>([\\s\\S]*?)</h${level}>([\\s\\S]*)$`,
      ).exec(section)!;
      const headingId = /\bid="([^"]*)"/.exec(attributes)?.[1];
      const input = `tabs-${group}-${index + 1}`;
      return (
        `<input type="radio" class="doc-tab-input" name="tabs-${group}" id="${input}"` +
        `${index === 0 ? " checked" : ""}>` +
        `<label class="tab doc-tab" for="${input}">${title}</label>` +
        `<div class="doc-tab-panel"${headingId ? ` id="${headingId}"` : ""}>${panel}</div>`
      );
    });
    return `<div class="doc-tabs">${tabs.join("")}</div>`;
  });
}

function textOf(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** The text of the first `<h1>`, the page's title. */
function firstHeading(html: string): string | undefined {
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  return (match && textOf(match[1])) || undefined;
}

/** The first paragraph, shortened, for the page's description. */
function firstParagraph(html: string): string | undefined {
  const match = /<p>([\s\S]*?)<\/p>/.exec(html);
  const text = match ? textOf(match[1]) : "";
  if (text === "") return undefined;
  return text.length <= 160 ? text : `${text.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}

/**
 * The sidebar's groups, with each page's title. Every page must be listed exactly once, and
 * every listed file must exist.
 */
export function navigationGroups(
  groups: NavigationGroup[],
  titles: Map<string, string>,
): DocGroup[] {
  const listed = groups.flatMap((group) => group.sources);
  const problems = [
    ...listed
      .filter((source) => !titles.has(source))
      .map((source) => `navigation.ts lists docs/${source}, which is missing`),
    ...listed
      .filter((source, index) => listed.indexOf(source) !== index)
      .map((source) => `navigation.ts lists docs/${source} more than once`),
    ...[...titles.keys()]
      .filter((source) => !listed.includes(source))
      .map((source) => `docs/${source} is missing from navigation.ts`),
  ];
  if (problems.length > 0) {
    throw new Error(`The documentation's sidebar is out of date:\n${problems.join("\n")}`);
  }
  return groups.map((group) => ({
    title: group.title,
    links: group.sources.map((source) => ({
      page: docPagePath(source),
      title: titles.get(source)!,
    })),
  }));
}

/** A title for a Markdown file without a heading, from its name. */
function titleFromName(source: string): string {
  if (/(^|\/)README\.md$/i.test(source)) return "Documentation";
  const name = posix.basename(source).replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The repository on GitHub, such as `https://github.com/<org>/quaso`, if it can be found. */
async function findRepositoryUrl(): Promise<string | undefined> {
  const explicit = process.env["SITE_REPOSITORY_URL"];
  if (explicit) return explicit.replace(/\/+$/, "");
  const server = process.env["GITHUB_SERVER_URL"];
  const repository = process.env["GITHUB_REPOSITORY"];
  if (server && repository) return `${server}/${repository}`;
  try {
    const output = await new Deno.Command("git", {
      args: ["remote", "get-url", "origin"],
      cwd: REPOSITORY,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return undefined;
    const remote = new TextDecoder().decode(output.stdout).trim();
    // git@github.com:org/repo.git or https://github.com/org/repo(.git); never credentials.
    const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote);
    return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined; // No git.
  }
}

/** The `<base href>` for 404.html, from `BASE_PATH`: `/`, `/quaso/`. */
function baseHref(): string {
  const value = (process.env["BASE_PATH"] ?? "").trim();
  if (/^https?:\/\//.test(value)) return value.replace(/\/*$/, "/");
  const path = value.replace(/^\/+|\/+$/g, "");
  return path === "" ? "/" : `/${path}/`;
}

function kindOf(path: string): PathKind {
  try {
    const info = fsSync.statSync(join(REPOSITORY, ...path.split("/")));
    return info.isDirectory() ? "folder" : "file";
  } catch {
    return undefined;
  }
}

interface Doc extends LinkSource {
  markdown: string;
  title: string;
  description?: string;
  html: string;
}

async function writeOutput(path: string, contents: string): Promise<void> {
  const file = join(OUT, ...path.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

/** Check rendered links and fragments, including screenshots, stylesheets and icons. */
export function brokenOutputLinks(pages: Map<string, string>, files: Set<string>): string[] {
  const errors: string[] = [];
  const base = "https://quaso.invalid/";
  for (const [source, html] of pages) {
    for (const match of html.matchAll(/<(?:a|img|link)\s[^>]*?(?:href|src)="([^"]+)"/g)) {
      const href = unescapeHtml(match[1]);
      if (!href || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(href)) continue;
      const url = new URL(href, base + source);
      let target: string;
      let fragment: string;
      try {
        target = decodeURIComponent(url.pathname.slice(1));
        fragment = decodeURIComponent(url.hash.slice(1));
      } catch {
        errors.push(`${source}: invalid encoded link "${href}"`);
        continue;
      }
      if (!target || target.endsWith("/")) target += "index.html";
      if (!files.has(target)) {
        errors.push(`${source}: "${href}" leads to missing output ${target}`);
      } else if (fragment && pages.has(target)) {
        const ids = new Set(
          [...pages.get(target)!.matchAll(/\bid="([^"]+)"/g)].map((id) => unescapeHtml(id[1])),
        );
        if (!ids.has(fragment)) errors.push(`${source}: "${href}" has no matching heading or ID`);
      }
    }
  }
  return errors;
}

/** Builds the site into site/dist/. Broken internal links fail the build. */
export async function build(): Promise<string[]> {
  const warnings: string[] = [];
  const repositoryUrl = await findRepositoryUrl();
  const context: LinkContext = { repositoryUrl, kind: kindOf, warn: (m) => warnings.push(m) };

  await fs.rm(OUT, { recursive: true }).catch((error) => {
    if (!((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  });
  await cp(join(SITE, "public"), OUT, { recursive: true });

  // Every file in docs/, except hidden ones: Markdown becomes pages, the rest is copied.
  const docs: Doc[] = [];
  for await (const entry of walk(DOCS, { includeDirs: false, followSymlinks: false })) {
    const source = relative(DOCS, entry.path).split(SEPARATOR).join("/");
    if (source.split("/").some((part) => part.startsWith("."))) continue;
    if (/\.md$/i.test(source)) {
      const markdown = await fs.readFile(entry.path, "utf8");
      docs.push({ source, page: docPagePath(source), markdown, title: "", html: "" });
    } else {
      await mkdir(dirname(join(OUT, "docs", source)), { recursive: true });
      await fs.copyFile(entry.path, join(OUT, "docs", source));
    }
  }
  docs.sort((a, b) => a.page.localeCompare(b.page));

  for (const doc of docs) {
    doc.html = rewriteLinks(renderTabs(render(doc.markdown)), doc, context);
    doc.title = firstHeading(doc.html) ?? titleFromName(doc.source);
    doc.description = firstParagraph(doc.html);
  }
  const navigation = navigationGroups(
    NAVIGATION,
    new Map(docs.map((doc) => [doc.source, doc.title])),
  );

  for (const doc of docs) {
    await writeOutput(
      doc.page,
      renderDoc({
        page: doc.page,
        title: doc.title,
        description: doc.description,
        html: doc.html,
        navigation,
        repositoryUrl,
        sourceUrl: repositoryUrl && repositoryFileUrl(repositoryUrl, `docs/${doc.source}`),
      }),
    );
  }

  const hasDoc = (source: string) => docs.some((doc) => doc.source === source);
  await writeOutput(HOME, renderLanding({ hasDoc, repositoryUrl }));
  await writeOutput("404.html", renderNotFound({ baseHref: baseHref(), repositoryUrl }));
  const styles = await bundleStylesheet(new URL("./src/styles.css", import.meta.url));
  await writeOutput(SITE_CSS, styles.css);
  for (const [name, source] of styles.assets) {
    await fs.copyFile(source, join(OUT, "assets", name));
  }
  for (const font of [10, 15, 20, 25]) {
    await fs.copyFile(
      new URL(import.meta.resolve(`@quaso/design-system/assets/Jersey-${font}-OFL.txt`)),
      join(OUT, `assets/Jersey-${font}-OFL.txt`),
    );
  }
  await writeOutput(GFM_CSS, await fs.readFile(join(SITE, "src", "markdown.css"), "utf8"));

  const pages = new Map<string, string>();
  const files = new Set<string>();
  for await (const entry of walk(OUT, { includeDirs: false })) {
    const output = relative(OUT, entry.path).split(SEPARATOR).join("/");
    files.add(output);
    if (output.endsWith(".html")) pages.set(output, await fs.readFile(entry.path, "utf8"));
  }
  warnings.push(...brokenOutputLinks(pages, files));
  if (warnings.length > 0) {
    throw new Error(`Broken internal links:\n${[...new Set(warnings)].join("\n")}`);
  }
  console.log(`Built ${docs.length + 2} pages into ${relative(process.cwd(), OUT) || "."}`);
  return warnings;
}

if (import.meta.main) {
  const warnings = await build();
  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} broken links:`);
    for (const warning of warnings) console.warn(`  ${warning}`);
  }
}
