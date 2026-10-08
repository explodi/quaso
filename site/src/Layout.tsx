// SPDX-License-Identifier: MIT
import { A, Wordmark } from "@quaso/design-system";
/**
 * The frame around every page: the HTML document (pre-rendering only) and the header,
 * navigation and footer (pre-rendering and the development server).
 */
import type { ReactNode } from "react";
import { DOCS_HOME, HOME, relativeHref, repositoryFileUrl } from "./paths.ts";

export interface DocumentProps {
  /** The page's output path, such as `docs/cli.html`; links are relative to it. */
  page: string;
  title: string;
  description: string;
  /** Style sheets, as output paths such as `assets/site.css`. */
  stylesheets: string[];
  /** A `<base href>` for pages served at any address, such as 404.html. */
  baseHref?: string;
  children: ReactNode;
}

/** The complete document for the static site, using the system color preference. */
export function Document({
  page,
  title,
  description,
  stylesheets,
  baseHref,
  children,
}: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {baseHref && <base href={baseHref} />}
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="color-scheme" content="light dark" />
        <link rel="icon" type="image/svg+xml" href={relativeHref(page, "favicon.svg")} />
        {stylesheets.map((sheet) => (
          <link key={sheet} rel="stylesheet" href={relativeHref(page, sheet)} />
        ))}
      </head>
      <body>{children}</body>
    </html>
  );
}

export interface ShellProps {
  /** The page's output path, such as `docs/cli.html`; links are relative to it. */
  page: string;
  /** The part of the site the page belongs to, highlighted in the navigation. */
  section: "home" | "docs" | "none";
  /** The repository on GitHub, such as `https://github.com/<org>/quaso`, if known. */
  repositoryUrl?: string;
  children: ReactNode;
}

/** The skip link, header, main content and footer: the body of every page. */
export function Shell({ page, section, repositoryUrl, children }: ShellProps) {
  const current = (target: string, inSection: boolean) =>
    page === target ? "page" : inSection ? "true" : undefined;
  return (
    <>
      <A className="skip-link" href="#site-content">
        Skip to content
      </A>
      <header className="site-header">
        <div className="container site-header-inner">
          <A className="site-brand" href={relativeHref(page, HOME)} aria-label="Quaso home">
            <Wordmark />
          </A>
          <nav aria-label="Main">
            <ul className="site-nav">
              <li>
                <A href={relativeHref(page, HOME)} aria-current={current(HOME, false)}>
                  Home
                </A>
              </li>
              <li>
                <A
                  href={relativeHref(page, DOCS_HOME)}
                  aria-current={current(DOCS_HOME, section === "docs")}
                >
                  Documentation
                </A>
              </li>
              {repositoryUrl && (
                <li>
                  <A href={repositoryUrl}>Source code</A>
                </li>
              )}
            </ul>
          </nav>
        </div>
      </header>
      <main id="site-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="container">
          <p>
            Quaso is open source under the{" "}
            {repositoryUrl ? (
              <A href={repositoryFileUrl(repositoryUrl, "LICENSE")}>MIT licence</A>
            ) : (
              "MIT licence"
            )}
            .
          </p>
        </div>
      </footer>
    </>
  );
}
