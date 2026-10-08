// SPDX-License-Identifier: MIT
import {
  H1,
  H2,
  H3,
  PixelPattern,
  QuasoMascot,
} from "../../packages/web/src/components/Typography.tsx";
import { AnchorButton } from "../../packages/web/src/components/Button.tsx";
import { A } from "../../packages/web/src/components/Controls.tsx";
/**
 * The landing page: what Quaso is, how the translation workflow goes, and where to read
 * more. Screenshots show the real demo project in the development server.
 */
import { docPagePath, DOCS_HOME, relativeHref } from "./paths.ts";

export interface LandingProps {
  /** The page's output path; links are relative to it. */
  page: string;
  /**
   * Whether a Markdown file in docs/ exists, from its path relative to docs/. The page
   * links only to documentation that exists; without it, every guide is linked.
   */
  hasDoc?: (source: string) => boolean;
  /** The repository on GitHub, if known. */
  repositoryUrl?: string;
}

interface Guide {
  /** The Markdown file, relative to docs/. */
  source: string;
  title: string;
  summary: string;
}

const GUIDES: { heading: string; guides: Guide[] }[] = [
  {
    heading: "For teams using Quaso",
    guides: [
      {
        source: "add-to-your-game.md",
        title: "Add Quaso to your game",
        summary: "Set up the CLI and send your first files.",
      },
      {
        source: "workflow.md",
        title: "From your repository to every language",
        summary: "Upload, review, auto-translate and download with project tasks.",
      },
      {
        source: "cli.md",
        title: "The CLI",
        summary: "Upload, translate, download, import and release status gates.",
      },
      {
        source: "migrate-from-crowdin.md",
        title: "Migrate from Crowdin",
        summary: "Bring your translations and your proofreading with you.",
      },
      {
        source: "website.md",
        title: "Translating and reviewing on the website",
        summary: "For volunteers and managers.",
      },
    ],
  },
  {
    heading: "For operators",
    guides: [
      {
        source: "deploy-docker.md",
        title: "Deploy with Docker Compose",
        summary: "One container and one SQLite file, on any VM.",
      },
      {
        source: "deploy-cloudflare.md",
        title: "Deploy on Cloudflare",
        summary: "The same application on Cloudflare Containers.",
      },
      {
        source: "configuration.md",
        title: "Configuration reference",
        summary: "Every setting, and its default.",
      },
      {
        source: "operations.md",
        title: "Backups, restores and upgrades",
        summary: "Keeping an instance healthy.",
      },
    ],
  },
  {
    heading: "For contributors",
    guides: [
      {
        source: "contributing/design-system.md",
        title: "Design system",
        summary: "Shared components, colors, typography, and the live catalog.",
      },
      {
        source: "contributing/architecture.md",
        title: "Architecture",
        summary: "How the parts of Quaso fit together.",
      },
      {
        source: "contributing/testing.md",
        title: "Testing",
        summary: "Offline tests, browser tests and storage parity.",
      },
      {
        source: "contributing/cloudflare.md",
        title: "Cloudflare development",
        summary: "The optional Worker, Durable Object and container.",
      },
      {
        source: "releasing.md",
        title: "Releasing Quaso",
        summary: "Versions, checks, published artifacts and recovery.",
      },
    ],
  },
];

const FEATURES = [
  {
    title: "No limits",
    text: "On words, strings or languages. Only storage and the LLM bill limit an instance.",
  },
  {
    title: "LLM first, people second",
    text:
      "New strings can be translated automatically after an upload. " +
      "Volunteers and managers proofread afterwards.",
  },
  {
    title: "Your files are never at risk",
    text:
      "The CLI never changes the source files, downloads are byte-stable, and unreviewed " +
      "work never reaches the files.",
  },
  {
    title: "Human work is never lost",
    text:
      "The LLM never overwrites a proofread translation, and every change is kept in " + "history.",
  },
  {
    title: "Easy to run",
    text: "One Deno application and one SQLite database, in one Docker container.",
  },
];

export function Landing({ page, hasDoc, repositoryUrl }: LandingProps) {
  const guide = (source: string, title: string) =>
    (hasDoc?.(source) ?? true) ? (
      <A href={relativeHref(page, docPagePath(source))}>{title}</A>
    ) : (
      <>
        {title} <span className="soon">(coming soon)</span>
      </>
    );

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="container">
          <div className="hero-stage">
            <PixelPattern className="hero-pattern" />
            <QuasoMascot />
            <p className="status">1.0 release candidate</p>
            <H1 display id="hero-title">
              Your game.
              <br />
              Everyone’s world.
            </H1>
            <p className="lead">
              Meet Quaso. Open-source localization for your game. AI gives you a head start. People
              give every language its voice.
            </p>
            <p className="actions">
              <AnchorButton variant="primary" href={relativeHref(page, DOCS_HOME)}>
                Read the documentation
              </AnchorButton>
              {repositoryUrl && (
                <AnchorButton href={repositoryUrl}>Source code on GitHub</AnchorButton>
              )}
            </p>
          </div>
          <figure className="hero-product">
            <img
              src={relativeHref(page, "screenshots/editor-pl.png")}
              width="1440"
              height="960"
              alt="Quaso’s translation workspace, with source text and Polish translations side by side"
            />
            <figcaption>Your whole party, on the same page.</figcaption>
          </figure>
        </div>
      </section>

      <section className="section" aria-labelledby="workflow-title">
        <div className="container">
          <H2 id="workflow-title">How it works</H2>
          <ol className="steps">
            <li>
              <H3>Upload with the CLI</H3>
              <p>
                <code>npx quaso upload</code> sends your source language's i18next JSON files. New
                strings arrive untranslated, and changed ones mark their old translations as
                outdated.
              </p>
              <p className="state state-red">Untranslated</p>
            </li>
            <li>
              <H3>The LLM translates at once</H3>
              <p>
                With automatic translation enabled, the LLM processes new and changed strings. Only
                results that pass the quality checks, such as placeholders and plural forms, are
                saved.
              </p>
              <p className="state state-green">Translated by the LLM</p>
            </li>
            <li>
              <H3>People proofread on the website</H3>
              <p>
                Anyone can browse the translations. Volunteers suggest fixes, managers approve them,
                and the LLM never overwrites a proofread translation.
              </p>
              <p className="state state-blue">Proofread</p>
            </li>
            <li>
              <H3>Download with the CLI</H3>
              <p>
                <code>npx quaso download</code> writes every language's files back into your
                repository, and touches only the files whose contents changed. Unapproved
                suggestions never reach them.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="section section-subtle" aria-labelledby="screenshots-title">
        <div className="container">
          <H2 id="screenshots-title">The translation workspace</H2>
          <div className="screenshots">
            <figure>
              <img
                src={relativeHref(page, "screenshots/dashboard.png")}
                width="1440"
                height="960"
                alt="Quaso dashboard showing language progress, translated and proofread counts"
                loading="lazy"
              />
              <figcaption>Progress by language, with states in words and colors.</figcaption>
            </figure>
            <figure>
              <img
                src={relativeHref(page, "screenshots/editor-pl.png")}
                width="1440"
                height="960"
                alt="Polish plural editor with one, few, many and other inputs and placeholder chips"
                loading="lazy"
              />
              <figcaption>Plural forms and quality checks next to the source text.</figcaption>
            </figure>
            <figure>
              <img
                src={relativeHref(page, "screenshots/review.png")}
                width="1440"
                height="960"
                alt="Review queue showing pending suggestions for a manager to approve"
                loading="lazy"
              />
              <figcaption>Volunteer suggestions wait for a manager's review.</figcaption>
            </figure>
            <figure>
              <img
                src={relativeHref(page, "screenshots/editor-dark.png")}
                width="1440"
                height="960"
                alt="Quaso translation editor in its dark theme"
                loading="lazy"
              />
              <figcaption>The same editor in the dark theme.</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="section section-subtle" aria-labelledby="features-title">
        <div className="container">
          <H2 id="features-title">Why Quaso</H2>
          <ul className="features">
            {FEATURES.map((feature) => (
              <li key={feature.title}>
                <H3>{feature.title}</H3>
                <p>{feature.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="deploy-title">
        <div className="container">
          <H2 id="deploy-title">Run your own instance</H2>
          <p>
            One instance serves one game, for example at <code>translate.yourgame.com</code>.
          </p>
          <ul className="cards">
            <li>
              <H3>{guide("deploy-docker.md", "Docker Compose")}</H3>
              <p>
                Point a domain at your VM, copy three deployment files, set your domain and Gemini
                key, and run <code>docker compose up -d</code>. Caddy handles HTTPS.
              </p>
            </li>
            <li>
              <H3>{guide("deploy-cloudflare.md", "Cloudflare")}</H3>
              <p>
                The same application on Cloudflare Containers, with its data in a Durable Object.
              </p>
            </li>
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="adopt-title">
        <div className="container">
          <H2 id="adopt-title">Connect your game</H2>
          <p>
            Install <code>@quaso/cli</code>, set your instance hostname and API key, then run
            <code>npx quaso init --languages de,fr,pl</code>. Your config maps source globs to
            language folders. Use the same commands locally and in CI.
          </p>
          <p>{guide("add-to-your-game.md", "Add Quaso to your game")}</p>
        </div>
      </section>

      <section className="section section-subtle" aria-labelledby="docs-title">
        <div className="container">
          <H2 id="docs-title">Documentation</H2>
          <div className="guides">
            {GUIDES.map((group) => (
              <div key={group.heading}>
                <H3>{group.heading}</H3>
                <ul>
                  {group.guides.map((item) => (
                    <li key={item.source}>
                      {guide(item.source, item.title)}
                      <span className="guide-summary">{item.summary}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p>
            <A href={relativeHref(page, DOCS_HOME)}>All documentation</A>
          </p>
        </div>
      </section>
    </>
  );
}
