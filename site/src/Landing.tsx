// SPDX-License-Identifier: MIT
import {
  A,
  AnchorButton,
  CheckIcon,
  ColourLabel,
  Details,
  FileIcon,
  GitHubIcon,
  H1,
  H2,
  H3,
  MonitorIcon,
  PixelPattern,
  Summary,
  UploadIcon,
} from "@quaso/design-system";
import type { ReactNode } from "react";
import { docPagePath, DOCS_HOME, relativeHref, repositoryFileUrl } from "./paths.ts";

export interface LandingProps {
  /** The page's output path; links are relative to it. */
  page: string;
  /** Whether a Markdown file exists, from its path relative to docs/. */
  hasDoc?: (source: string) => boolean;
  repositoryUrl?: string;
}

/** Each feature's art is a game inventory item that plays on its headline, in the mascot's pixel style. */
const FEATURES = [
  {
    art: "treasure-chest",
    title: "Open source. All yours.",
    text: "MIT licensed and self-hosted. No per-seat pricing, word limits, or language caps. Make yourself at home.",
    note: "Free to use. Free to make your own.",
  },
  {
    art: "coin-stack",
    title: "Small stack. Small bill.",
    text: "One Quaso container and a SQLite database. Run it on your own VM with Docker Compose, or deploy on Cloudflare.",
    note: "Your hosting. Your budget.",
  },
  {
    art: "magic-key",
    title: "Your LLM key. Your call.",
    text: "Bring your Gemini API key for a first draft. Choose your model, set a token budget, and pay your provider directly.",
    note: "A head start, on your terms.",
  },
  {
    art: "campfire",
    title: "Made for your whole party.",
    text: "Translate with your team, invite volunteer suggestions, or let an LLM help. Managers review; human proofreading stays protected.",
    note: "People give every language its voice.",
  },
  {
    art: "scroll",
    title: "Made for game strings.",
    text: "i18next JSON with plural forms, placeholders, and quality checks built in. More of your game’s files are on the way.",
    note: "Steam VDF + Markdown · coming soon",
  },
  {
    art: "sailboat",
    title: "Ship files. Keep your freedom.",
    text: "Translations come back as ordinary JSON files in your repository. Your game runs on its own, with no connection to Quaso.",
    note: "Fits your build. Works in CI.",
  },
];

/** A static, selectable code example. No client-side syntax library is needed. */
function Terminal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="window-mark" aria-hidden="true">
          ■ ■ ■
        </span>
        <span>{title}</span>
        <span aria-hidden="true">↗</span>
      </div>
      <pre tabIndex={0} aria-label={`${title} commands`}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Command({ children }: { children: ReactNode }) {
  return (
    <span className="command">
      <span className="prompt" aria-hidden="true">
        ${" "}
      </span>
      {children}
    </span>
  );
}

function Screenshot({
  page,
  name,
  alt,
  caption,
  width = 1440,
  height = 960,
}: {
  page: string;
  name: string;
  alt: string;
  caption: string;
  width?: number;
  height?: number;
}) {
  const src = relativeHref(page, `screenshots/${name}.png`);
  return (
    <figure className="product-shot">
      <A href={src} aria-label={`View full-size screenshot: ${caption}`}>
        <img src={src} width={width} height={height} alt={alt} loading="lazy" />
      </A>
      <figcaption>
        {caption}
        <span aria-hidden="true"> ↗</span>
      </figcaption>
    </figure>
  );
}

export function Landing({ page, hasDoc, repositoryUrl }: LandingProps) {
  const guide = (source: string, title: string) =>
    (hasDoc?.(source) ?? true) ? (
      <A className="text-link" href={relativeHref(page, docPagePath(source))}>
        {title} <span aria-hidden="true">↗</span>
      </A>
    ) : (
      <span>
        {title} <span className="soon">(coming soon)</span>
      </span>
    );

  return (
    <div className="landing">
      <section className="hero" aria-labelledby="hero-title">
        <div className="container">
          <div className="hero-grid">
            <div className="hero-copy">
              <p className="eyebrow">
                <span className="section-index">I</span> A LITTLE INTRODUCTION
              </p>
              <H1 display id="hero-title">
                Your game.
                <br />
                Everyone’s
                <br />
                <span className="hero-highlight">adventure.</span>
              </H1>
              <p className="lead">
                Meet Quaso, the open-source localization platform for games. Translate with LLMs,
                your team, and your community. Then get back to making worlds.
              </p>
              <div className="actions">
                <AnchorButton
                  variant="primary"
                  href={relativeHref(page, docPagePath("deploy-docker.md"))}
                >
                  Get started <span aria-hidden="true">→</span>
                </AnchorButton>
                <A className="text-link" href="#how-it-works">
                  See how it works <span aria-hidden="true">↓</span>
                </A>
              </div>
              <p className="hero-footnote">Free & open source. Bring your own keys.</p>
            </div>
            <div className="hero-scene">
              <PixelPattern tone="mint" className="hero-weave" />
              <div className="mascot-greeting">
                <span className="speech-bubble">Bonjour, world!</span>
                <img
                  src={relativeHref(page, "art/quaso-wave.svg")}
                  width="160"
                  height="128"
                  alt="Quaso, the croissant cat, waving hello"
                />
              </div>
              <div className="translation-window">
                <div className="translation-bar">
                  <span className="window-mark" aria-hidden="true">
                    ■ ■ ■
                  </span>
                  <span>QUASO QUEST</span>
                  <FileIcon />
                </div>
                <div className="translation-body">
                  <div className="string-meta">
                    <code>game.json</code>
                    <span>welcome.title</span>
                  </div>
                  <div className="language-label">
                    <span>FR</span> French <span className="language-role">Source</span>
                  </div>
                  <p className="example-string" lang="fr">
                    Le goûter n'attend pas !
                  </p>
                  <div className="translation-divider">
                    <span aria-hidden="true">↓</span>
                    <span>A new language. The same little adventure.</span>
                  </div>
                  <div className="language-label">
                    <span>EN</span> English <span className="language-role">Translation</span>
                  </div>
                  <p className="example-string">Snack time won't wait!</p>
                  <div className="translation-proof">
                    <ColourLabel colour="blue">Proofread</ColourLabel>
                    <span>
                      Ready for your players <CheckIcon />
                    </span>
                  </div>
                </div>
              </div>
              <span className="scene-caption">Real words from our little example game.</span>
            </div>
          </div>
          <div className="format-strip">
            <span className="eyebrow">LESS FRICTION. MORE PLAYERS.</span>
            <span>
              <CheckIcon /> i18next JSON
            </span>
            <span>
              Steam VDF <span className="soon">coming soon</span>
            </span>
            <span>
              Markdown <span className="soon">coming soon</span>
            </span>
          </div>
        </div>
      </section>

      <section className="section why-section" id="why-quaso" aria-labelledby="why-title">
        <div className="container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                <span className="section-index">II</span> WHY QUASO
              </p>
              <H2 display id="why-title">
                Small team?
                <br />
                Big world.
              </H2>
            </div>
            <p>
              Localization should feel like part of making your game. Here are six ways Quaso keeps
              it that way.
            </p>
          </div>
          <ul className="features">
            {FEATURES.map(({ art, title, text, note }, index) => (
              <li key={title} className={index === 0 ? "feature feature-lime" : "feature"}>
                <div className="feature-top">
                  <img
                    className="feature-art"
                    src={relativeHref(page, `art/${art}.svg`)}
                    width="48"
                    height="48"
                    alt=""
                  />
                  <span>0{index + 1}</span>
                </div>
                <H3>{title}</H3>
                <p>{text}</p>
                <span className="feature-note">{note}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        className="section workflow-section"
        id="how-it-works"
        aria-labelledby="workflow-title"
      >
        <div className="container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                <span className="section-index">III</span> FROM YOUR REPO TO THE WORLD
              </p>
              <H2 display id="workflow-title">
                Four steps.
                <br />A whole new audience.
              </H2>
            </div>
            <p>
              Follow Quaso Quest from French to English. Same game, new words, one simple round
              trip.
            </p>
          </div>
          <ol className="workflow-steps">
            <li className="workflow-step">
              <div className="step-copy">
                <span className="step-number" aria-hidden="true">
                  01
                </span>
                <H3>Give Quaso a home.</H3>
                <p>
                  Copy the deployment files, set your domain and setup key, and start Docker
                  Compose. Create your admin account in the browser. Your translation space is
                  ready.
                </p>
                <div className="step-links">
                  {guide("deploy-docker.md", "The Docker setup guide")}
                  {guide("deploy-cloudflare.md", "Prefer Cloudflare?")}
                </div>
              </div>
              <div className="deploy-visual">
                <Terminal title="your server">
                  <span className="code-comment"># With your deployment files configured</span>
                  {"\n"}
                  <Command>docker compose up -d</Command>
                </Terminal>
                <div
                  className="hosting-diagram"
                  aria-label="Quaso application with a SQLite database, behind Caddy HTTPS"
                >
                  <span>
                    <MonitorIcon size={22} /> Quaso app
                  </span>
                  <span aria-hidden="true">+</span>
                  <span>
                    <FileIcon size={22} /> SQLite
                  </span>
                  <span className="hosting-footer">
                    <CheckIcon /> HTTPS handled by Caddy
                  </span>
                </div>
              </div>
            </li>
            <li className="workflow-step">
              <div className="step-copy">
                <span className="step-number" aria-hidden="true">
                  02
                </span>
                <H3>Send over your strings.</H3>
                <p>
                  Install the CLI in your game’s repository. Set your instance hostname and API key,
                  then map your language folders. Upload your source files whenever the story grows.
                </p>
                <div className="file-route">
                  <code>src/locales/fr/*.json</code>
                  <UploadIcon />
                  <span>Quaso</span>
                </div>
                <div className="step-links">
                  {guide("add-to-your-game.md", "Connect your game")}
                </div>
              </div>
              <Terminal title="your game / terminal">
                <Command>
                  npm i -D <span className="code-accent">@quaso-i18n/cli</span>
                </Command>
                {"\n\n"}
                <span className="code-comment"># Connect to your instance</span>
                {"\n"}
                <Command>export QUASO_HOSTNAME=translate.yourgame.com</Command>
                {"\n"}
                <Command>
                  export QUASO_API_KEY=<span className="code-string">'your upload API key'</span>
                </Command>
                {"\n\n"}
                <span className="code-comment"># French in, English and German out</span>
                {"\n"}
                <Command>
                  npx quaso init <span className="code-accent">--source fr --languages en,de</span>
                </Command>
                {"\n"}
                <Command>npx quaso upload</Command>
              </Terminal>
            </li>
            <li className="workflow-step step-translate">
              <div className="step-copy">
                <span className="step-number" aria-hidden="true">
                  03
                </span>
                <H3>Find the words together.</H3>
                <p>
                  Let an LLM draft a translation, write it yourself, or invite your community to
                  help. Review suggestions with the source, placeholders, and plural forms right
                  beside you.
                </p>
                <ul className="translation-states">
                  <li>
                    <ColourLabel colour="red">Untranslated</ColourLabel>
                    <span>A fresh line of dialogue.</span>
                  </li>
                  <li>
                    <ColourLabel colour="green">Translated by the LLM</ColourLabel>
                    <span>A first draft to build on.</span>
                  </li>
                  <li>
                    <ColourLabel colour="blue">Proofread</ColourLabel>
                    <span>The words you want to keep.</span>
                  </li>
                </ul>
                <div className="step-links">
                  {guide("website.md", "Meet your translation workspace")}
                </div>
              </div>
              <Screenshot
                page={page}
                name="editor-en"
                alt="Quaso Quest’s editor showing French game dialogue and its English translation, with placeholders preserved"
                caption="French → English, inside the real Quaso workspace."
              />
              <Details className="workspace-gallery">
                <Summary>
                  Take a closer look at the workspace{" "}
                  <span className="gallery-hint">Progress, reviews & dark mode</span>
                </Summary>
                <div className="screenshots">
                  <Screenshot
                    page={page}
                    name="dashboard"
                    alt="Quaso Quest dashboard with translation and proofreading progress by language"
                    caption="See how every language is coming along."
                  />
                  <Screenshot
                    page={page}
                    name="review"
                    alt="English suggestions for Quaso Quest’s French strings waiting for a manager’s review"
                    caption="Give community suggestions a second pair of eyes."
                  />
                  <Screenshot
                    page={page}
                    name="editor-dark"
                    alt="The same French-to-English Quaso Quest translation editor in dark mode"
                    caption="Late-night translating? Make yourself comfortable."
                  />
                </div>
              </Details>
            </li>
            <li className="workflow-step step-game">
              <div className="step-copy">
                <span className="step-number" aria-hidden="true">
                  04
                </span>
                <H3>Bring your world back home.</H3>
                <p>
                  Download the translations into your game’s language folders, review the diff, and
                  ship. Your game loads ordinary files. No runtime connection. Just more people in
                  on the adventure.
                </p>
                <Terminal title="back in your game">
                  <Command>npx quaso download</Command>
                  <span className="code-comment">
                    {"\n\n"}# src/locales/en/game.json{"\n"}# Ready for your next build.
                  </span>
                </Terminal>
                {repositoryUrl && (
                  <A
                    className="text-link"
                    href={repositoryFileUrl(repositoryUrl, "examples/demo-game", true)}
                  >
                    Try the Quaso Quest walkthrough <span aria-hidden="true">↗</span>
                  </A>
                )}
              </div>
              <Screenshot
                page={page}
                name="quaso-quest"
                width={964}
                height={624}
                alt="Quaso Quest, a pixel-art game about a croissant cat collecting butter, running with the downloaded English translations"
                caption="Same buttery adventure. A whole new language."
              />
            </li>
          </ol>
        </div>
      </section>

      <section className="closing-section" aria-labelledby="start-title">
        <PixelPattern className="closing-pattern" />
        <div className="container closing-inner">
          <div>
            <p className="eyebrow">MADE FOR GAMES. AND THE PEOPLE WHO MAKE THEM.</p>
            <H2 display id="start-title">
              Your next player
              <br />
              is out there.
            </H2>
            <p>Give them a world that speaks their language.</p>
          </div>
          <div className="closing-actions">
            <AnchorButton
              variant="primary"
              href={relativeHref(page, docPagePath("deploy-docker.md"))}
            >
              Let’s get you set up <span aria-hidden="true">→</span>
            </AnchorButton>
            {repositoryUrl && (
              <A href={repositoryUrl}>
                <GitHubIcon size={20} /> Explore the source on GitHub
              </A>
            )}
          </div>
        </div>
      </section>
      <section className="resource-section" aria-label="More ways to get started">
        <div className="container resource-links">
          <div>
            <span className="eyebrow">YOUR NEXT QUEST</span>
            <A className="text-link" href={relativeHref(page, DOCS_HOME)}>
              Explore all documentation <span aria-hidden="true">↗</span>
            </A>
          </div>
          <div>
            {guide("workflow.md", "The complete workflow")}
            <p>From your first upload to release day.</p>
          </div>
          <div>
            {guide("migrate-from-crowdin.md", "Coming from Crowdin?")}
            <p>Bring your translations along.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
