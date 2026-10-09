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
    text: "Bring your Gemini API key. Choose the model, write the instructions, set a monthly token budget, and pay your provider directly.",
    note: "No markup. No middleman.",
  },
  {
    art: "campfire",
    title: "Made for your whole party.",
    text: "Your team proofreads directly. Volunteers from your community suggest fixes for a manager to approve. Anyone can read along, no account needed.",
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

/** The same release, planned the usual way and with Quaso: when do players get their language? */
const USUAL_RELEASE = [
  { when: "Week 1", text: "Freeze the strings and send them to translators." },
  { when: "Weeks 2–4", text: "Wait. A late change to the text means waiting again." },
  { when: "Week 5", text: "Ship every language, a month after the game was ready." },
];

const QUASO_RELEASE = [
  { when: "Monday", text: "Push the new strings. The LLM translates them in minutes." },
  { when: "Monday", text: "Ship the build in every language." },
  { when: "All week", text: "Your team and community proofread, whenever suits them." },
  { when: "Friday", text: "The next build ships their fixes. Nobody waited." },
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

/** One way to plan a release, as a short timeline that ends with when players get their language. */
function ReleaseLane({
  title,
  steps,
  outcome,
  className,
}: {
  title: string;
  steps: { when: string; text: string }[];
  outcome: string;
  className: string;
}) {
  return (
    <div className={`release-lane ${className}`}>
      <H3>{title}</H3>
      <ol className="release-steps">
        {steps.map(({ when, text }) => (
          <li key={text}>
            <span className="release-when">{when}</span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
      <p className="release-outcome">{outcome}</p>
    </div>
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
                <span className="hero-highlight">Ship today.</span>
                <br />
                Proofread
                <br />
                tomorrow.
              </H1>
              <p className="lead">
                Quaso is open-source localization for games. An LLM translates new strings as soon
                as you upload them, so your next build speaks every language. Your team and
                community proofread at their own pace, and each fix ships in the build after.
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
                    <span>lose.kicker</span>
                  </div>
                  <div className="language-label">
                    <span>FR</span> French <span className="language-role">Source</span>
                  </div>
                  <p className="example-string" lang="fr">
                    ÇA SENT LE PAIN GRILLÉ
                  </p>
                  <div className="translation-divider">
                    <span aria-hidden="true">↓</span>
                    <span>English, one build apart.</span>
                  </div>
                  <ol className="build-history">
                    <li>
                      <div className="build-label">
                        <ColourLabel colour="green">Translated by the LLM</ColourLabel>
                        <span>Monday’s build</span>
                      </div>
                      <p className="example-string">IT SMELLS LIKE TOAST</p>
                    </li>
                    <li>
                      <div className="build-label">
                        <ColourLabel colour="blue">Proofread by Alex</ColourLabel>
                        <span>Friday’s build</span>
                      </div>
                      <p className="example-string">YOU’RE TOAST</p>
                    </li>
                  </ol>
                  <p className="translation-proof">
                    <CheckIcon /> In players’ hands both times. Nobody waited.
                  </p>
                </div>
              </div>
              <span className="scene-caption">One line from our little example game.</span>
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
                Nobody waits
                <br />
                for anybody.
              </H2>
            </div>
            <p>
              Done the usual way, a release waits for its slowest language. With Quaso, the LLM’s
              translations ship with your next build, and people make them better while you keep
              making the game.
            </p>
          </div>
          <div className="release-compare">
            <ReleaseLane
              className="release-usual"
              title="The usual way"
              steps={USUAL_RELEASE}
              outcome="Players get their language in week five."
            />
            <ReleaseLane
              className="release-quaso"
              title="With Quaso"
              steps={QUASO_RELEASE}
              outcome="Players get their language on day one."
            />
          </div>
          <ul className="safeguards" aria-label="Why it is safe to ship before proofreading">
            <li>
              <H3>Proofreading is never lost.</H3>
              <p>
                The LLM never overwrites a person’s translation. When the source text changes, it
                proposes an update for a manager to approve.
              </p>
            </li>
            <li>
              <H3>Checked before it ships.</H3>
              <p>
                LLM translations pass the same placeholder, plural and length checks as a person’s.
                One that keeps failing stays untranslated, and the game shows the source text.
              </p>
            </li>
            <li>
              <H3>Strict where it counts.</H3>
              <p>
                Want a language fully proofread before launch day? Add{" "}
                <code>quaso status --fail-on green</code> to your release, and it waits until it is.
              </p>
            </li>
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
                <br />
                No waiting.
              </H2>
            </div>
            <p>
              Follow Quaso Quest from French to English. Its English ships before anyone proofreads
              it, and gets better with every build.
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
                  Compose. Create your admin account in the browser and paste in your Gemini API
                  key. Your translation space is ready.
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
                <H3>Upload. It’s translated.</H3>
                <p>
                  Install the CLI in your game’s repository and upload your source files whenever
                  the story grows. The LLM translates every new and changed string in minutes, and
                  checks each one’s placeholders, plural forms and length.
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
                {"\n\n"}
                <span className="code-comment"># Upload, and wait while the LLM translates</span>
                {"\n"}
                <Command>
                  npx quaso upload <span className="code-accent">--wait</span>
                </Command>
              </Terminal>
            </li>
            <li className="workflow-step step-game">
              <div className="step-copy">
                <span className="step-number" aria-hidden="true">
                  03
                </span>
                <H3>Ship it in every language.</H3>
                <p>
                  Download the translations into your game’s language folders and ship. The LLM’s
                  translations go out with this build: nobody has to approve them first. Your game
                  loads ordinary files, with no connection to Quaso.
                </p>
                <Terminal title="back in your game">
                  <Command>npx quaso download</Command>
                  <span className="code-comment">
                    {"\n\n"}# src/locales/en/game.json{"\n"}# src/locales/de/game.json{"\n"}# Ready
                    for tonight’s build.
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
                caption="Same buttery adventure in English, before anyone proofread its dialogue."
              />
            </li>
            <li className="workflow-step step-translate">
              <div className="step-copy">
                <span className="step-number" aria-hidden="true">
                  04
                </span>
                <H3>Proofread at your own pace.</H3>
                <p>
                  Your team and your community proofread in the browser, with the source,
                  placeholders and plural forms right beside them. The LLM never overwrites their
                  work, and your next download brings every fix into the game.
                </p>
                <ul className="translation-states">
                  <li>
                    <ColourLabel colour="red">Untranslated</ColourLabel>
                    <span>Players see the source text for now.</span>
                  </li>
                  <li>
                    <ColourLabel colour="green">Translated by the LLM</ColourLabel>
                    <span>Ships with your next build.</span>
                  </li>
                  <li>
                    <ColourLabel colour="blue">Proofread</ColourLabel>
                    <span>Checked by a person. Ships with the build after the fix.</span>
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
                    caption="See how much is translated, and how much is proofread."
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
                    caption="Late-night proofreading? Make yourself comfortable."
                  />
                </div>
              </Details>
            </li>
          </ol>
          <div className="workflow-loop">
            <span className="loop-mark" aria-hidden="true">
              ↻
            </span>
            <p>
              Steps two to four repeat with every build. Put them in CI, and each release picks up
              whatever was translated and proofread since the last one.
            </p>
            {guide("add-to-your-game.md", "Automate it in CI")}
          </div>
        </div>
      </section>

      <section className="section features-section" aria-labelledby="features-title">
        <div className="container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                <span className="section-index">IV</span> MADE FOR SMALL TEAMS
              </p>
              <H2 display id="features-title">
                Small team?
                <br />
                Big world.
              </H2>
            </div>
            <p>
              Localization should feel like part of making your game. Here are six more ways Quaso
              keeps it that way.
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
            <p>Ship their language with your next build. Make it better with every one after.</p>
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
