// SPDX-License-Identifier: MIT
/**
 * Renders whole pages to static HTML with react-dom/server, for build.ts. The pages need
 * no JavaScript, and the site ships none.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type DocLink, DocPage } from "./DocPage.tsx";
import { Landing } from "./Landing.tsx";
import { Document, Shell } from "./Layout.tsx";
import { NotFound } from "./NotFound.tsx";
import { GFM_CSS, HOME, SITE_CSS } from "./paths.ts";

export const TITLE = "Quaso — ship every language today, proofread tomorrow";

const DESCRIPTION =
  "Open-source game localization that never holds up a release. An LLM translates new " +
  "strings as you upload them, so your next build ships in every language; your team and " +
  "community proofread at their own pace. Self-hosted, with your own API keys.";

const DOCS_DESCRIPTION =
  "Documentation for Quaso, an open-source localization platform for " +
  "apps and games that use i18next.";

function toHtml(element: ReactElement): string {
  return `<!doctype html>\n${renderToStaticMarkup(element)}\n`;
}

export interface LandingOptions {
  /** Whether a Markdown file in docs/ exists, from its path relative to docs/. */
  hasDoc: (source: string) => boolean;
  repositoryUrl?: string;
}

/** The landing page, at index.html. */
export function renderLanding({ hasDoc, repositoryUrl }: LandingOptions): string {
  return toHtml(
    <Document page={HOME} title={TITLE} description={DESCRIPTION} stylesheets={[SITE_CSS]}>
      <Shell page={HOME} section="home" repositoryUrl={repositoryUrl}>
        <Landing page={HOME} hasDoc={hasDoc} repositoryUrl={repositoryUrl} />
      </Shell>
    </Document>,
  );
}

export interface DocOptions {
  /** The page's output path, such as `docs/cli.html`. */
  page: string;
  title: string;
  description?: string;
  /** The rendered Markdown. */
  html: string;
  /** Every documentation page, for the navigation. */
  pages: DocLink[];
  repositoryUrl?: string;
  /** The Markdown file on GitHub. */
  sourceUrl?: string;
}

/** A documentation page. */
export function renderDoc(options: DocOptions): string {
  const { page, title, html, pages, repositoryUrl, sourceUrl } = options;
  return toHtml(
    <Document
      page={page}
      title={title.includes("Quaso") ? title : `${title} · Quaso`}
      description={options.description ?? DOCS_DESCRIPTION}
      stylesheets={[SITE_CSS, GFM_CSS]}
    >
      <Shell page={page} section="docs" repositoryUrl={repositoryUrl}>
        <DocPage page={page} html={html} pages={pages} sourceUrl={sourceUrl} />
      </Shell>
    </Document>,
  );
}

export interface NotFoundOptions {
  /** The address of the site's root, such as `/quaso/`: GitHub Pages serves 404.html anywhere. */
  baseHref: string;
  repositoryUrl?: string;
}

/** The page for missing addresses, at 404.html. */
export function renderNotFound({ baseHref, repositoryUrl }: NotFoundOptions): string {
  const page = "404.html";
  return toHtml(
    <Document
      page={page}
      title="Page not found · Quaso"
      description={DESCRIPTION}
      stylesheets={[SITE_CSS]}
      baseHref={baseHref}
    >
      <Shell page={page} section="none" repositoryUrl={repositoryUrl}>
        <NotFound page={page} />
      </Shell>
    </Document>,
  );
}
