// SPDX-License-Identifier: MIT
import { A } from "../../packages/web/src/components/Controls.tsx";
import { H1 } from "../../packages/web/src/components/Typography.tsx";
/** The page GitHub Pages shows for an address that has no page. */
import { DOCS_HOME, HOME, relativeHref } from "./paths.ts";

export function NotFound({ page }: { page: string }) {
  return (
    <section className="section" aria-labelledby="not-found-title">
      <div className="container">
        <H1 id="not-found-title">Page not found</H1>
        <p>There is no page at this address. It may have moved.</p>
        <ul>
          <li>
            <A href={relativeHref(page, HOME)}>Quaso's home page</A>
          </li>
          <li>
            <A href={relativeHref(page, DOCS_HOME)}>The documentation</A>
          </li>
        </ul>
      </div>
    </section>
  );
}
