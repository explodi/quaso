// SPDX-License-Identifier: MIT
import { A, H2, H3 } from "@quaso/design-system";
/** A documentation page: Markdown from docs/, rendered to HTML, beside the grouped sidebar. */
import { relativeHref } from "./paths.ts";

export interface DocLink {
  /** The page's output path, such as `docs/cli.html`. */
  page: string;
  title: string;
}

export interface DocGroup {
  title: string;
  links: DocLink[];
}

export interface DocPageProps {
  /** This page's output path. */
  page: string;
  /** The rendered Markdown: HTML rendered from repository Markdown. */
  html: string;
  /** Every documentation page, in the sidebar's groups and order. */
  navigation: DocGroup[];
  /** The Markdown file on GitHub, if the repository is known. */
  sourceUrl?: string;
}

export function DocPage({ page, html, navigation, sourceUrl }: DocPageProps) {
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
        {navigation.map((group) => (
          <section key={group.title} className="docs-nav-group">
            <H3>{group.title}</H3>
            <ul>
              {group.links.map((link) => (
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
          </section>
        ))}
      </nav>
    </div>
  );
}
