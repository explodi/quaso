// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import { DEFAULT_SYNTAX, type TranslationInfo } from "@quaso/core";
import {
  A,
  AnchorButton,
  Button,
  Card,
  Checkbox,
  Chip,
  ColourLabel,
  Details,
  Dialog,
  Dropdown,
  EmptyState,
  Field,
  Fieldset,
  H1,
  H2,
  H3,
  H4,
  IconButton,
  Input,
  Kbd,
  Label,
  Loading,
  Notice,
  PixelPattern,
  Progress,
  QuasoMascot,
  Radio,
  Select,
  Spinner,
  Summary,
  Switch,
  Table,
  Tabs,
  TextArea,
  ThemeSwitch,
  Wordmark,
  useDarkTheme,
} from "@quaso/design-system";
import { ButtonLink } from "../components/Button.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { MainNavigation } from "../components/MainNavigation.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { SourceText } from "../components/SourceText.tsx";
import { StateBadge, StateMarker } from "../components/StateBadge.tsx";
import { useToast } from "../components/Toast.tsx";
import * as Icons from "@quaso/design-system/icons";
import { FileTree } from "../components/FileTree.tsx";
import { SelectField, TextField, ConfirmButton } from "../components/Management.tsx";
import { buildTree } from "../lib/tree.ts";
import { contrastRatio } from "@quaso/design-system/contrast";
import { PALETTE, THEMES, TOKENS } from "@quaso/design-system/tokens";

const SECTIONS = [
  ["principles", "The idea"],
  ["identity", "Mascot & patterns"],
  ["typography", "Typography"],
  ["palette", "Color palette"],
  ["buttons", "Buttons & links"],
  ["forms", "Forms & controls"],
  ["feedback", "Status & feedback"],
  ["navigation", "Navigation & data"],
  ["translation", "Translation workspace"],
  ["guidelines", "Putting it together"],
] as const;

const translation: TranslationInfo = {
  value: "Deine Worte. Eine ganze Welt.",
  colour: "green",
  outdated: false,
  revision: 1,
  qa: { errors: 0, warnings: 0 },
  author: { type: "llm", id: null, name: "Quaso" },
  approver: null,
  updatedAt: 0,
};
const sampleProgress = {
  strings: 20,
  words: 100,
  untranslated: 4,
  green: 6,
  blue: 10,
  outdated: 0,
  pending: 0,
  qa: 0,
  wordsLeft: 20,
  translatedPercent: 80,
  proofreadPercent: 50,
};
const files = buildTree([
  { ...sampleProgress, id: 1, path: "common.json", repoPath: "common.json" },
  { ...sampleProgress, id: 2, path: "menus/settings.json", repoPath: "menus/settings.json" },
  { ...sampleProgress, id: 3, path: "menus/welcome.json", repoPath: "menus/welcome.json" },
]);

function Section({
  id,
  number,
  title,
  description,
  children,
}: {
  id: string;
  number: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="catalog-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="catalog-section-heading">
        <span className="catalog-index">{number}</span>
        <div>
          <H2 id={`${id}-title`}>{title}</H2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Specimen({
  title,
  code,
  children,
  wide = false,
}: {
  title: string;
  code: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`specimen${wide ? " specimen-wide" : ""}`}>
      <div className="specimen-heading">
        <H3 ui>{title}</H3>
      </div>
      <div className="specimen-body">{children}</div>
      <code className="specimen-code">{code}</code>
    </div>
  );
}

function Palette() {
  const dark = useDarkTheme();
  const theme = THEMES[dark ? "dark" : "light"];
  const toast = useToast();
  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(`var(--${name})`);
      toast.show(`Copied var(--${name})`);
    } catch {
      toast.show(`Use var(--${name}) in your stylesheet.`, "info");
    }
  }
  return (
    <>
      <div className="brand-palette">
        {[
          ["ink-950", "Deep plum", "The world behind the pixels."],
          ["lime-400", "Power lime", "An unmistakable next move."],
          ["mint-300", "Mint", "A fresh perspective."],
          ["paper-50", "Starlight", "A little room to breathe."],
        ].map(([token, name, note]) => (
          <div key={token} className="brand-swatch">
            <Button
              variant="plain"
              className="swatch-color"
              style={{ background: `var(--${token})` }}
              onClick={() => copy(token)}
              aria-label={`Copy ${name} color token`}
            />
            <strong>{name}</strong>
            <span>{note}</span>
            <code>--{token}</code>
          </div>
        ))}
      </div>
      <Details className="palette-details" open>
        <Summary>Every palette shade</Summary>
        <div className="shade-families">
          {Object.entries(PALETTE).map(([name, shades]) => (
            <div key={name} className="shade-family">
              <strong>{name}</strong>
              <div className="shade-strip">
                {Object.entries(shades).map(([shade, hex]) => (
                  <Button
                    key={shade}
                    variant="plain"
                    className="shade"
                    onClick={() => copy(`${name}-${shade}`)}
                    aria-label={`Copy ${name} ${shade}, ${hex}`}
                  >
                    <span style={{ background: `var(--${name}-${shade})` }} />
                    <code>{shade}</code>
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Details>
      <Details className="palette-details">
        <Summary>Semantic tokens · {dark ? "dark" : "light"} theme</Summary>
        <p className="catalog-note">
          Use a role such as <code>var(--fg)</code> in components. Switch the theme to inspect its
          paired shade. Select a swatch to copy its variable.
        </p>
        <div className="semantic-palette">
          {TOKENS.map((token) => (
            <Button
              variant="plain"
              key={token}
              className="semantic-token"
              onClick={() => copy(token)}
            >
              <span
                className="semantic-dot"
                style={
                  token === "shadow"
                    ? { boxShadow: "var(--shadow)" }
                    : { background: `var(--${token})` }
                }
              />
              <span>
                <code>--{token}</code>
                <small>{theme[token]}</small>
              </span>
            </Button>
          ))}
        </div>
      </Details>
      <p className="contrast-note">
        <Icons.CheckSquareIcon /> Body text: {contrastRatio(theme.fg, theme.bg).toFixed(1)}:1 ·
        Secondary text: {contrastRatio(theme["fg-muted"], theme.bg).toFixed(1)}:1 contrast in this
        theme.
      </p>
    </>
  );
}

function Forms() {
  const [notify, setNotify] = useState(true);
  const [language, setLanguage] = useState("de");
  const [review, setReview] = useState("human");
  const [text, setText] = useState("Words should feel at home, in every language.");
  return (
    <div className="specimen-grid">
      <Specimen title="Text fields" code={'<Field label="Project name" hint="…" />'}>
        <Field
          label="Project name"
          defaultValue="A world of words"
          hint="A clear name makes a good first impression."
        />
        <Field
          label="Email address"
          type="email"
          defaultValue="hello@"
          error="Enter a complete email address."
        />
        <Field label="Read only" value="The original stays safe." readOnly />
        <Field label="Unavailable" value="Not available for your role" disabled />
      </Specimen>
      <Specimen title="Select & search" code={'<Select>…</Select> · <Input type="search" />'}>
        <Label className="field">
          Translation language
          <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="de">Deutsch · German</option>
            <option value="ja">日本語 · Japanese</option>
            <option value="ar">العربية · Arabic</option>
          </Select>
        </Label>
        <Label className="field">
          Search strings
          <div className="search">
            <Icons.SearchIcon className="search-icon" />
            <Input type="search" className="search-input" placeholder="Find the right words…" />
          </div>
        </Label>
        <Label className="field">
          Words per page
          <Input type="number" min={10} max={100} step={10} defaultValue={20} />
        </Label>
        <Label className="field">
          Import a translation
          <Input type="file" accept=".json" />
        </Label>
      </Specimen>
      <Specimen
        title="Checkboxes, radios & switches"
        code={"<Checkbox /> · <Radio /> · <Switch />"}
      >
        <Fieldset className="catalog-choices">
          <legend>Notifications</legend>
          <Label>
            <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email me
            when a review is ready
          </Label>
          <Label>
            <Checkbox defaultChecked /> Include a weekly summary
          </Label>
          <Label>
            <Checkbox disabled /> Managed by your administrator
          </Label>
        </Fieldset>
        <Fieldset className="catalog-choices">
          <legend>Review preference</legend>
          <Label>
            <Radio
              name="review"
              value="human"
              checked={review === "human"}
              onChange={() => setReview("human")}
            />{" "}
            A person has the final word
          </Label>
          <Label>
            <Radio
              name="review"
              value="all"
              checked={review === "all"}
              onChange={() => setReview("all")}
            />{" "}
            Show every translation
          </Label>
        </Fieldset>
        <Label className="catalog-switch-label">
          <Switch defaultChecked /> Automatic translation
        </Label>
        <Label className="catalog-switch-label">
          <Switch disabled /> Unavailable switch
        </Label>
      </Specimen>
      <Specimen title="Room to write" code={'<TextArea lang="en" dir="auto" minRows={4} />'}>
        <Label className="field">
          English translation
          <TextArea
            lang="en"
            dir="auto"
            minRows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Label>
        <p className="field-hint">
          System type. Generous line spacing. No compressed letters in the text you work with.
        </p>
        <Label className="field">
          Arabic · right to left
          <TextArea lang="ar" dir="rtl" defaultValue="كلماتك تستحق أن تصل إلى الجميع." />
        </Label>
      </Specimen>
      <Specimen
        title="Labeled controls & appearance"
        code="<SelectField /> · <TextField /> · <ThemeSwitch />"
        wide
      >
        <div className="catalog-field-pair">
          <SelectField label="Review language" value={language} onChange={setLanguage}>
            <option value="de">Deutsch · German</option>
            <option value="ja">日本語 · Japanese</option>
            <option value="ar">العربية · Arabic</option>
          </SelectField>
          <TextField label="Translator’s note" value={text} onChange={setText} rows={2} />
        </div>
        <div className="catalog-row">
          <span className="field-label">Appearance</span>
          <ThemeSwitch />
          <ThemeSwitch variant="menu" />
        </div>
      </Specimen>
    </div>
  );
}

function Feedback() {
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [retried, setRetried] = useState(false);
  return (
    <>
      <div className="specimen-grid">
        <Specimen
          title="Translation states"
          code="<StateBadge /> · <StateMarker /> · <ColourLabel />"
        >
          <StateBadge summary={{ translation: null, pending: 0 }} />
          <StateBadge summary={{ translation, pending: 0 }} />
          <StateBadge summary={{ translation: { ...translation, colour: "blue" }, pending: 0 }} />
          <StateBadge
            summary={{
              translation: { ...translation, outdated: true, qa: { errors: 1, warnings: 0 } },
              pending: 2,
            }}
          />
          <div className="catalog-row">
            <StateMarker summary={{ translation, pending: 2 }} />
            <ColourLabel colour="blue" />
          </div>
          <p className="field-hint">
            Shape and a plain-language label accompany every state. Color never works alone.
          </p>
        </Specimen>
        <Specimen
          title="Progress & loading"
          code="<ProgressBar /> · <Progress /> · <Spinner /> · <Loading />"
        >
          <Label className="field">
            80% translated · 50% proofread
            <ProgressBar progress={sampleProgress} />
          </Label>
          <Label className="field">
            Importing strings
            <Progress aria-label="Importing strings" max={100} value={64} />
          </Label>
          <Spinner label="Finding the right words…" />
          <Loading label="Loading translations…" />
        </Specimen>
        <Specimen title="Notices & recovery" code="<Notice /> · <ErrorMessage />">
          <Notice title="A little context" icon={<Icons.InfoIcon />}>
            Changes here are examples for the catalog.
          </Notice>
          <Notice
            kind="success"
            title="All words accounted for."
            icon={<Icons.CheckSquareIcon />}
          />
          <Notice
            kind="warning"
            title="One placeholder needs a second look."
            icon={<Icons.WarningIcon />}
          />
          {retried ? (
            <Notice kind="success" title="Connection restored." />
          ) : (
            <ErrorMessage
              error={new Error("We couldn’t load the translation.")}
              onRetry={() => setRetried(true)}
            />
          )}
        </Specimen>
        <Specimen title="Dialogs & toasts" code="<Dialog /> · useToast()">
          <p>Clear decisions, a visible way back, and focus that returns to where you left off.</p>
          <div className="catalog-row">
            <Button onClick={() => setDialog(true)}>Open example dialog</Button>
            <Button onClick={() => toast.show("Translation saved. Nicely put.")}>
              Show success toast
            </Button>
          </div>
          <div className="catalog-row">
            <Button
              variant="ghost"
              onClick={() => toast.show("You’re viewing a local example.", "info")}
            >
              Information toast
            </Button>
            <Button
              variant="ghost"
              onClick={() => toast.show("Couldn’t save. Your words are still here.", "error")}
            >
              Error toast
            </Button>
          </div>
          <ConfirmButton
            title="Remove this example?"
            description="This is a local preview of a confirmation. No real translations are removed."
            onConfirm={async () => {
              toast.show("Example removed.", "info");
            }}
          >
            Confirm example removal
          </ConfirmButton>
          <EmptyState title="A clean slate." icon={<Icons.CheckSquareIcon size={28} />}>
            No translations waiting for review.
          </EmptyState>
        </Specimen>
      </div>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="A few well-chosen words."
        footer={
          <>
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setDialog(false);
                toast.show("Example saved.");
              }}
            >
              Save example
            </Button>
          </>
        }
      >
        <p>
          This is the same dialog used across Quaso. Press Escape to close it, or use Tab to move
          between its controls.
        </p>
        <Field label="Translation" defaultValue="Make yourself understood." />
      </Dialog>
    </>
  );
}

function Navigation() {
  const [tab, setTab] = useState("translation");
  const [file, setFile] = useState("common.json");
  const toast = useToast();
  return (
    <div className="specimen-grid">
      <Specimen
        title="Application navigation"
        code="<MainNavigation items={…} /> · <Dropdown />"
        wide
      >
        <MainNavigation
          items={[
            { to: "/", label: "Dashboard", exact: true },
            { to: "/activity", label: "Activity" },
            { to: "/glossary", label: "Glossary" },
            { to: "/issues", label: "Source issues", group: "Workspace" },
            { to: "/review", label: "Review queue", group: "Workspace" },
            { to: "/team", label: "Team", group: "Management" },
            { to: "/settings", label: "Settings", group: "Management" },
          ]}
        />
        <p className="field-hint">
          Common destinations stay visible on wide screens. The menu keeps every page within reach
          on a phone. Use Tab to move through links and Escape to close the menu.
        </p>
        <div className="catalog-row">
          <Dropdown label="Project actions" name="Example project actions">
            <Button
              variant="plain"
              className="menu-item"
              onClick={() => toast.show("Example project copied.")}
            >
              Copy project
            </Button>
            <Button
              variant="plain"
              className="menu-item"
              onClick={() => toast.show("Example export prepared.")}
            >
              Export translations
            </Button>
          </Dropdown>
        </div>
      </Specimen>
      <Specimen title="Tabs" code="<Tabs tabs={…} selected={…} onSelect={…} />">
        <Tabs
          label="Example translation details"
          tabs={[
            { id: "translation", label: "Translation" },
            { id: "context", label: "Context" },
            { id: "history", label: "History" },
          ]}
          selected={tab}
          onSelect={setTab}
        >
          <p className="pad">
            {tab === "translation"
              ? "Your words. Everyone’s world."
              : tab === "context"
                ? "The welcome message, shown when a reader opens the app."
                : "Mia proofread this translation. Every revision has a place here."}
          </p>
        </Tabs>
        <p className="field-hint">Use the arrow keys, Home, and End to move between tabs.</p>
        <Details>
          <Summary>A little more detail</Summary>
          <p>Native disclosure behavior, with one shared appearance.</p>
        </Details>
      </Specimen>
      <Specimen title="Files & folders" code="<FileTree nodes={…} onOpen={…} />">
        <FileTree
          nodes={files}
          label="Example project files"
          selected={file}
          onOpen={setFile}
          compact
        />
        <p className="field-hint" role="status">
          Selected: {file}
        </p>
      </Specimen>
      <Specimen title="Tables" code="<Table>…</Table>" wide>
        <div className="catalog-table-scroll">
          <Table>
            <caption>Example language coverage</caption>
            <thead>
              <tr>
                <th scope="col">Language</th>
                <th scope="col">Progress</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Deutsch</th>
                <td>100%</td>
                <td>
                  <ColourLabel colour="blue" />
                </td>
              </tr>
              <tr>
                <th scope="row">日本語</th>
                <td>80%</td>
                <td>
                  <ColourLabel colour="green" />
                </td>
              </tr>
              <tr>
                <th scope="row">العربية</th>
                <td>0%</td>
                <td>
                  <ColourLabel colour="red" />
                </td>
              </tr>
            </tbody>
          </Table>
        </div>
      </Specimen>
      <Specimen title="The icon family" code={"<SearchIcon size={18} /> · <Kbd>⌘</Kbd>"} wide>
        <div className="catalog-icons">
          {Object.entries(Icons).map(([name, Icon]) => (
            <span key={name} title={name}>
              <Icon size={22} />
              <small>{name.replace("Icon", "")}</small>
            </span>
          ))}
        </div>
        <p className="field-hint">
          Icons follow the text color. Icon-only actions always have an accessible name.{" "}
          <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
        </p>
      </Specimen>
    </div>
  );
}

function TranslationWorkspace() {
  const [text, setText] = useState(translation.value as string);
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  return (
    <Card className="catalog-workspace">
      <div className="workspace-top">
        <div className="catalog-row">
          <Icons.FileIcon />
          <span>common.json</span>
          <code>welcome.message</code>
        </div>
        <StateBadge
          summary={{
            translation: { ...translation, colour: saved ? "blue" : "green" },
            pending: 0,
          }}
        />
      </div>
      <div className="workspace-columns">
        <div>
          <p className="catalog-eyebrow">Source · English</p>
          <p className="workspace-source">
            <SourceText text="Your words. Everyone’s world." syntax={DEFAULT_SYNTAX} lang="en" />
          </p>
          <p className="muted">A warm welcome, wherever you call home.</p>
          <div className="workspace-context">
            <span className="catalog-eyebrow">With placeholders</span>
            <SourceText text="Welcome home, {{name}}." syntax={DEFAULT_SYNTAX} />
          </div>
        </div>
        <div>
          <Label className="field">
            <span className="catalog-eyebrow">Translation · German</span>
            <TextArea
              aria-label="German translation"
              lang="de"
              minRows={4}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(false);
              }}
            />
          </Label>
          <div className="catalog-row">
            <Chip
              kind="placeholder"
              shortcut={1}
              onClick={() => {
                setText((value) => `${value} {{name}}`);
                setSaved(false);
              }}
            >
              {"{{name}}"}
            </Chip>
            <Chip
              kind="reference"
              onClick={() => toast.show("A reference points to another source string.", "info")}
            >
              Reference
            </Chip>
            <Chip onClick={() => toast.show("Context copied to this example.", "info")}>
              Context
            </Chip>
          </div>
        </div>
      </div>
      <div className="workspace-bottom">
        <p className="field-hint">A working example. Your changes stay in this page.</p>
        <div className="catalog-row">
          <Button
            onClick={() => {
              setText(translation.value as string);
              setSaved(false);
            }}
          >
            Reset
          </Button>
          <Button
            variant="primary"
            icon={<Icons.CheckIcon />}
            disabled={!text.trim() || saved}
            onClick={() => {
              setSaved(true);
              toast.show("Example proofread. Your words look good.");
            }}
          >
            {saved ? "Proofread" : "Save & proofread"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function Catalog() {
  const toast = useToast();
  return (
    <div className="catalog">
      <A className="skip-link" href="#main">
        Skip to catalog
      </A>
      <header className="catalog-header">
        <A href="#" className="catalog-brand" aria-label="Quaso design system">
          <Wordmark />
          <span>Design system</span>
        </A>
        <div className="catalog-header-end">
          <span className="catalog-edition">Player guide / v.02</span>
          <ThemeSwitch variant="switch" />
          <A href="/" className="catalog-app-link">
            Open Quaso <span aria-hidden="true">↗</span>
          </A>
        </div>
      </header>
      <div className="catalog-layout">
        <aside className="catalog-sidebar">
          <p className="catalog-eyebrow">Select a level</p>
          <Label className="catalog-section-picker">
            Explore the catalog
            <Select
              aria-label="Jump to a catalog section"
              defaultValue="principles"
              onChange={(event) => {
                window.location.hash = event.target.value;
              }}
            >
              {SECTIONS.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Label>
          <nav aria-label="Catalog sections">
            {SECTIONS.map(([id, name], index) => (
              <A key={id} href={`#${id}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {name}
              </A>
            ))}
          </nav>
          <div className="catalog-sidebar-note">
            <span className="catalog-live-dot" /> One shared language.
            <br />
            Every corner of Quaso.
          </div>
        </aside>
        <main id="main" className="catalog-main" tabIndex={-1}>
          <section className="catalog-hero" id="principles" aria-labelledby="catalog-title">
            <div className="catalog-hero-stage">
              <PixelPattern className="catalog-hero-pattern" />
              <div className="catalog-hero-copy">
                <p className="catalog-eyebrow">Quaso / A design system for game worlds</p>
                <H1 display id="catalog-title">
                  Small pixels.
                  <br />
                  Big worlds.
                </H1>
                <p>Every game deserves to feel like home. In every language.</p>
                <AnchorButton variant="primary" href="#translation">
                  Try the workspace →
                </AnchorButton>
              </div>
              <div className="catalog-hero-mascot">
                <QuasoMascot />
                <span>Meet Quaso. Your co-op companion.</span>
              </div>
              <span className="catalog-hero-coordinate" aria-hidden="true">
                + 01 / READY
              </span>
            </div>
            <div className="catalog-intro">
              <p>
                Pixel type. Straight edges. A croissant with a cat inside. A little arcade energy
                for the people bringing game worlds to life.
              </p>
              <p>
                Expressive on the outside, comfortable where you work. Clear language, readable
                translations, and controls that always tell you what happens next.
              </p>
            </div>
            <div className="catalog-principles">
              <span>
                <b>01</b> Build on the pixel grid.
              </span>
              <span>
                <b>02</b> Give every world a voice.
              </span>
              <span>
                <b>03</b> Keep the work readable.
              </span>
            </div>
          </section>
          <Section
            id="identity"
            number="02"
            title="Meet your co-op companion."
            description="A tiny gray cat. A golden croissant. One unmistakably Quaso silhouette."
          >
            <div className="identity-grid">
              <div className="mascot-specimen">
                <QuasoMascot />
                <Wordmark />
                <p>Keep the pixels crisp. Give the little cat some space.</p>
              </div>
              <div className="pattern-specimens">
                <div>
                  <PixelPattern />
                  <span>01 / POWER LIME</span>
                </div>
                <div>
                  <PixelPattern tone="mint" />
                  <span>02 / MINT WAVE</span>
                </div>
                <div>
                  <PixelPattern tone="plum" />
                  <span>03 / NIGHT MODE</span>
                </div>
              </div>
            </div>
            <p className="catalog-note identity-note">
              Patterns live in banners and brand moments. Use solid surfaces behind text and
              controls. All corners are square; larger silhouettes step along the same grid.
            </p>
          </Section>
          <Section
            id="typography"
            number="03"
            title="Four fonts. One party."
            description="The Jersey family brings the game. System sans keeps every language easy to read."
          >
            <div className="type-specimens">
              <div className="type-display">
                <p className="catalog-eyebrow">The voice / Jersey 25</p>
                <span className="type-letters" aria-hidden="true">
                  Aa!
                </span>
                <H2>Press start.</H2>
                <p>400 weight · native proportions · square by nature</p>
              </div>
              <div className="type-reading">
                <p className="catalog-eyebrow">The work / System sans</p>
                <p className="type-reading-title">
                  Good words take time.
                  <br />
                  Reading them shouldn’t take effort.
                </p>
                <p>
                  The interface stays clear, calm, and familiar. Translation text uses your system’s
                  own typeface, with natural letter spacing and room between the lines.
                </p>
                <div className="type-languages">
                  <span lang="de">Für die richtigen Worte.</span>
                  <span lang="ja">言葉を、世界へ。</span>
                  <span lang="ar" dir="rtl">
                    لكل كلمة مكان.
                  </span>
                </div>
                <p className="type-metadata">
                  16px body · 1.65 translation line height · no fixed-height text
                </p>
              </div>
            </div>
            <Details className="catalog-type-scale" open>
              <Summary>The heading scale & wordmark</Summary>
              <div className="catalog-type-samples">
                <div>
                  <code>H1 / JERSEY 25</code>
                  <H1>A world worth sharing.</H1>
                </div>
                <div>
                  <code>H2 / JERSEY 20</code>
                  <H2>Your next adventure.</H2>
                </div>
                <div>
                  <code>H3 / JERSEY 15</code>
                  <H3>Bring the whole party.</H3>
                </div>
                <div>
                  <code>H4 / JERSEY 10</code>
                  <H4>Every detail counts.</H4>
                </div>
              </div>
              <code>H1 · H2 · H3 · H4 · ui · display · Wordmark</code>
            </Details>
          </Section>
          <Section
            id="palette"
            number="04"
            title="Choose your colors."
            description="Deep plum, power lime, cool mint. Two themes, the same game."
          >
            <Palette />
          </Section>
          <Section
            id="buttons"
            number="05"
            title="A clear invitation."
            description="Actions say what happens next. One component, wherever you meet it."
          >
            <div className="specimen-grid">
              <Specimen
                title="Everyday actions"
                code={'<Button variant="primary">Save translation</Button>'}
              >
                <div className="catalog-row">
                  <Button variant="primary" onClick={() => toast.show("Translation saved.")}>
                    Save translation
                  </Button>
                  <Button onClick={() => toast.show("Example cancelled.", "info")}>Cancel</Button>
                  <Button
                    variant="ghost"
                    onClick={() => toast.show("More example details.", "info")}
                  >
                    More details
                  </Button>
                </div>
                <div className="catalog-row">
                  <Button
                    variant="danger"
                    onClick={() => toast.show("Example removed. No real data was changed.", "info")}
                  >
                    Delete example
                  </Button>
                  <Button
                    variant="plain"
                    className="link-button"
                    onClick={() => toast.show("A quiet action.", "info")}
                  >
                    A quiet action
                  </Button>
                </div>
              </Specimen>
              <Specimen
                title="Size, icons & states"
                code={'<Button size="small" busy /> · <IconButton label="…" />'}
              >
                <div className="catalog-row">
                  <Button size="small" onClick={() => toast.show("Small action saved.")}>
                    Small action
                  </Button>
                  <Button icon={<Icons.CheckIcon />} onClick={() => toast.show("Approved.")}>
                    With an icon
                  </Button>
                  <IconButton
                    label="Copy example"
                    icon={<Icons.CopyIcon />}
                    onClick={() => toast.show("Example copy action.", "info")}
                  />
                </div>
                <div className="catalog-row">
                  <Button variant="primary" busy>
                    Saving…
                  </Button>
                  <Button disabled>Unavailable</Button>
                </div>
              </Specimen>
              <Specimen
                title="Links with a destination"
                code="<A /> · <AnchorButton /> · <ButtonLink />"
                wide
              >
                <div className="catalog-row">
                  <A href="#guidelines">Read the conventions →</A>
                  <AnchorButton href="/">Open the app ↗</AnchorButton>
                  <ButtonLink to="#translation">Try the workspace</ButtonLink>
                </div>
              </Specimen>
            </div>
          </Section>
          <Section
            id="forms"
            number="06"
            title="Make yourself understood."
            description="Familiar controls, visible labels, and useful feedback. Built on native browser behavior."
          >
            <Forms />
          </Section>
          <Section
            id="feedback"
            number="07"
            title="Nothing lost in translation."
            description="A word, a shape, and a color. Clear feedback without raising the volume."
          >
            <Feedback />
          </Section>
          <Section
            id="navigation"
            number="08"
            title="Everything in its place."
            description="Find your way, compare the details, and keep your place with the keyboard."
          >
            <Navigation />
          </Section>
          <Section
            id="translation"
            number="09"
            title="The words are the point."
            description="The same components, together. Try editing, inserting a placeholder, and saving a translation."
          >
            <TranslationWorkspace />
          </Section>
          <Section
            id="guidelines"
            number="10"
            title="One language. Everywhere."
            description="A living system, shared by the catalog, the product, and the public website."
          >
            <div className="catalog-guidelines">
              <div>
                <H3>Start with what’s here.</H3>
                <p>
                  Import shared controls from <code>@quaso/design-system</code>. Repeated buttons,
                  inputs, selects, radios, and other controls belong in the system.
                </p>
              </div>
              <div>
                <H3>Give color a purpose.</H3>
                <p>
                  Use semantic CSS variables. The palette in{" "}
                  <code>@quaso/design-system/tokens</code> defines every shade;{" "}
                  <code>deno task design:tokens</code> generates the themes.
                </p>
              </div>
              <div>
                <H3>Make room for people.</H3>
                <p>
                  Keep labels visible, focus easy to see, and translated text in system type.
                  Respect writing direction, zoom, and reduced motion.
                </p>
              </div>
            </div>
            <Notice title="One source of truth" icon={<Icons.InfoIcon />}>
              These examples render the real components. Change a shared component or token and the
              change follows it throughout Quaso. One-off compositions use the same palette and
              conventions.
            </Notice>
          </Section>
          <footer className="catalog-footer">
            <Wordmark />
            <p>Made for games. Built for everyone.</p>
            <A href="#">Back to the beginning ↑</A>
          </footer>
        </main>
      </div>
    </div>
  );
}
