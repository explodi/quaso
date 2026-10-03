// SPDX-License-Identifier: MIT
import { H2 } from "../../packages/web/src/components/Typography.tsx";
import { A } from "../../packages/web/src/components/Controls.tsx";
/** A documentation page: Markdown from docs/, rendered to HTML, with the list of pages. */
import { relativeHref } from "./paths.ts";

export interface DocLink {
  /** The page's output path, such as `docs/cli.html`. */
  page: string;
  title: string;
}

export interface DocPageProps {
  /** This page's output path. */
  page: string;
  /** The rendered Markdown: HTML rendered from repository Markdown. */
  html: string;
  /** Every documentation page, in the order of the navigation. */
  pages: DocLink[];
  /** The Markdown file on GitHub, if the repository is known. */
  sourceUrl?: string;
}

export function DocPage({ page, html, pages, sourceUrl }: DocPageProps) {
  return (
    <div className="container docs-layout">
      <div className="docs-content">
        <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
        {sourceUrl && (
          <p className="docs-source">
            <A href={sourceUrl}>View this page on GitHub</A>
          </p>
        )}
      </div>
      <nav className="docs-nav" aria-labelledby="docs-nav-title">
        <H2 id="docs-nav-title">Documentation</H2>
        <ul>
          {pages.map((link) => (
            <li key={link.page}>
              <A
                href={relativeHref(page, link.page)}
                aria-current={link.page === page ? "page" : undefined}
              >
                {link.title}
              </A>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
