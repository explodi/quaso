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
    text: "MIT licensed and self-hosted. Run your own instance and change the source to fit your project.",
    note: "You pay for hosting and external services.",
  },
  {
    art: "coin-stack",
    title: "Host it your way.",
    text: "One Quaso container and a SQLite database. Run it on your own virtual machine with Docker Compose, or deploy on Cloudflare.",
    note: "Your hosting. Your budget.",
  },
  {
    art: "magic-key",
    title: "Your LLM key. Your call.",
    text: "Bring your Gemini API key. Choose the model, write the instructions, set a monthly token budget, and pay your provider directly.",
    note: "Pay the provider directly.",
  },
  {
    art: "campfire",
    title: "Built for your team.",
    text: "Managers edit and proofread translations. Contributors suggest changes for review. Visitors can read source text and translations without an account.",
    note: "People give every language its voice.",
  },
  {
    art: "scroll",
    title: "Made for game strings.",
    text: "i18next and ICU MessageFormat, with placeholders and plural forms in JSON strings or whole Markdown documents. Choose your project’s message format in Settings → Placeholders. Check structure and length before accepting a translation.",
    note: "JSON and Markdown · i18next or ICU MessageFormat",
  },
  {
    art: "sailboat",
    title: "Ship files. Keep your freedom.",
    text: "Translations come back as ordinary files in your repository. Your game runs on its own, with no connection to Quaso.",
    note: "Fits your build. Works in CI.",
  },
];

/** Example release plans with proofreading before or after the first release. */
const USUAL_RELEASE = [
  { when: "Week 1", text: "Freeze the strings and send them to translators." },
  { when: "Weeks 2–4", text: "Translate and proofread the text." },
  { when: "Week 5", text: "Release the reviewed languages." },
];

const QUASO_RELEASE = [
  { when: "Monday", text: "Upload the new strings and run a translation job." },
  { when: "Monday", text: "Check the results and release the completed languages." },
  { when: "All week", text: "Your team and community proofread, whenever suits them." },
  { when: "Friday", text: "Download accepted fixes for the next build." },
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
                Quaso is an open-source tool for translating games. With a Gemini key, uploads can
                queue machine translations for review. Download accepted translations into your next
                build, then include your team's fixes in later builds.
              </p>
              <div className="actions">
                <AnchorButton variant="primary" href={relativeHref(page, DOCS_HOME)}>
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
                    <CheckIcon /> Both translations appear in a game build.
                  </p>
                </div>
              </div>
              <span className="scene-caption">One line from our little example game.</span>
            </div>
          </div>
          <div className="format-strip">
            <span className="eyebrow">SUPPORTED FORMATS</span>
            <span>
              <CheckIcon /> i18next JSON v4
            </span>
            <span>
              <CheckIcon /> ICU MessageFormat
            </span>
            <span>
              <CheckIcon /> Markdown
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
                Choose when
                <br />
                to release.
              </H2>
            </div>
            <p>
              Decide which languages need proofreading before release. You can include accepted
              machine translations in a build and add reviewed changes in later builds.
            </p>
          </div>
          <div className="release-compare">
            <ReleaseLane
              className="release-usual"
              title="A release after proofreading"
              steps={USUAL_RELEASE}
              outcome="Example plan: finish proofreading before release."
            />
            <ReleaseLane
              className="release-quaso"
              title="With Quaso"
              steps={QUASO_RELEASE}
              outcome="Example plan: release checked machine translations, then proofread."
            />
          </div>
          <ul className="safeguards" aria-label="Translation checks and review controls">
            <li>
              <H3>Keep proofread translations.</H3>
              <p>
                The LLM does not replace a proofread translation. With proposals enabled, a source
                change can produce an update for a manager to review.
              </p>
            </li>
            <li>
              <H3>Check the text structure.</H3>
              <p>
                LLM results must pass placeholder, plural, and length checks before they are saved.
                A failed result leaves the previous value in place. People still need to check
                meaning and tone.
              </p>
            </li>
            <li>
              <H3>Strict where it counts.</H3>
              <p>
                Want a language fully proofread before launch day? Add{" "}
                <code>quaso status --fail-on untranslated,outdated,green</code> to your build. A
                matching state makes the command fail; review QA and pending counts separately.
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
                <span className="section-index">III</span> FROM YOUR REPOSITORY TO THE WORLD
              </p>
              <H2 display id="workflow-title">
                Four steps.
                <br />
                From text to build.
              </H2>
            </div>
            <p>
              Follow Quaso Quest from French to English. This example uses a machine translation
              first, then adds a person's changes in a later build.
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
                <H3>Upload and translate.</H3>
                <p>
                  Install the CLI in your game’s repository and upload your source files whenever
                  the story grows. With a Gemini key and automatic translation enabled, uploads
                  queue work for new and changed strings. Check the job result before downloading.
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
                  npm i -D <span className="code-accent">@quaso-i18n/cli@main</span>
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
                <H3>Download for your build.</H3>
                <p>
                  Download accepted translations into your game's language folders. Missing
                  translations use source text by default; outdated translations remain included.
                  Check the files in your game before release. The game needs no Quaso connection.
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
                caption="The example game running in English, before anyone proofread its dialogue."
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
                  proofread work. Your next download includes accepted fixes for your build.
                </p>
                <ul className="translation-states">
                  <li>
                    <ColourLabel colour="red">Untranslated</ColourLabel>
                    <span>Downloads use source text by default.</span>
                  </li>
                  <li>
                    <ColourLabel colour="green">Translated</ColourLabel>
                    <span>Accepted for download; not yet proofread.</span>
                  </li>
                  <li>
                    <ColourLabel colour="blue">Proofread</ColourLabel>
                    <span>Checked by a person and accepted for download.</span>
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
              Translation should feel like part of making your game. Here are six more ways Quaso
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
            <AnchorButton variant="primary" href={relativeHref(page, DOCS_HOME)}>
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
