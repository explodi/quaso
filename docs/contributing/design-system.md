# The Quaso design system

Use the shared design system to build controls and layouts that fit the Quaso app and project
website. The component catalog shows working examples and their states.

After [development setup](README.md), run `npm run dev` and open
[the catalog](http://localhost:5173/design.html). The catalog needs no account or project data and
makes no API calls. `npm run build:web` also includes `design.html` in the app build.

The app, catalog, and public website depend on the workspace package `@quaso/design-system` in
`packages/design-system`. It owns the base React components, shared CSS, theme tokens, icons, mascot,
and licensed fonts. Editing the package updates all three sites. The website's static build
bundles the package's styles and referenced assets without adding client-side JavaScript.

The package has no dependency on the application, API types, router, or translation model.
Application workflows and route adapters stay in `packages/web`; landing-page and documentation
layouts stay in `site`. Import through the package's exports, not relative paths into its source.
ESLint and the package's dependency test enforce that boundary.

## Use shared controls

Import components from `@quaso/design-system`, and load the shared stylesheet once before your
site's layout styles:

```tsx
import { Button, Field, H1, Input } from "@quaso/design-system";
import "@quaso/design-system/styles.css";
```

`@quaso/design-system/icons`, `/tokens`, and `/contrast` expose the icon collection, palette data,
and color calculations. `@quaso/design-system/assets/*` exposes the mascot, patterns, fonts, and
font licenses for builds that copy assets.

Use `Button`, `Input`, `Select`, `Checkbox`, `Radio`, `Switch`, `TextArea`,
`Label`, `Fieldset`, `Progress`, `Table`, `Details`, `Summary`, and `Dialog`. `Field` adds an associated
label, hint, and validation error to an input. Native props, event handlers, and refs still work.

The app keeps its router-aware `Link` and `ButtonLink` adapters locally; both compose package
base components. Use the package's `A` and `AnchorButton` for browser navigation, external destinations,
and downloads. `Button` defaults to `type="button"`; forms submit explicitly
with `type="submit"`. Busy buttons keep keyboard focus and ignore repeated clicks.

The package also provides tabs, dropdowns, notices, empty states, progress, chips, status markers,
and icons. File trees, toasts, translation status, placeholders, and the working translation
composition in the catalog demonstrate application components built with these base components.
Business workflows remain in the app; their controls and colors come from the system.

The app's `MainNavigation` groups workspace links under Project, Contribute, and Manage. Desktop
pages use a sidebar; narrow screens and the focused editor use a compact menu. Settings has its
own grouped sidebar and a matching mobile selector. These layouts stay in the application. `Dropdown` also powers the account menu: it closes on Escape,
outside clicks, or when focus leaves, and keeps ordinary links and actions in the Tab order.
Current links carry `aria-current="page"`; keep the active state and keyboard focus distinct.
The header's `ThemeSwitch variant="menu"` keeps system, light, and dark choices in one icon button;
the catalog uses `variant="switch"` for its direct light/dark toggle.

ESLint rejects native control tags in the app, site, and design system outside the shared
component implementations. A repeated control belongs
in this library and the catalog. Layout elements such as `section`, `div`, `span`, and `p` stay native.

## Color has a single source

`packages/design-system/src/styles/tokens.ts` defines named color groups and shades. The light and dark
maps assign those shades to named roles. Component styles use roles such as `var(--surface)`,
`var(--fg)`, `var(--danger)`, and `var(--selected)` instead of literal colors. Brand examples can use
palette variables such as `var(--lime-400)` directly. Transparency mixes declared palette
colors with `transparent`.

The brand palette pairs deep plum (`#261230`), lime (`#d7ff64`), mint (`#80e5dc`), and
off-white (`#f4f4f1`), inspired by [Astral](https://astral.sh/). Light mode uses pale solid
surfaces and plum text; dark mode uses plum surfaces and light text. Lime identifies primary
actions in both. Status colors have separate named roles. Keep their shapes and labels so readers do not need to
distinguish colors to understand a state.

After editing the palette or theme roles, run:

```sh
npm run design:tokens
npx vitest run packages/design-system
```

The generator updates `theme.css` and both favicons. Commit the generated files with the palette.
The tests check generated output and listed text/control contrast pairs in both themes. They also
simulate two types of red–green color blindness to check the state colors. These checks do not
replace a review of the rendered pages. Authored stylesheets must not
introduce literal colors outside the palette.

Themes follow the system until someone chooses light or dark. The catalog switch and the app's
three-way theme menu use the package's theme store, persisted as `quaso.theme` in browser local
storage. The public website follows the system preference with CSS and works without JavaScript.

## Typography and comfort

Use `H1` through `H4` for titles. All four Jersey fonts ship locally at their native 400 weight;
do not stretch, compress, or synthesize bold. The same mapping applies to documentation headings.

| Level | Font      | Default size        |
| ----- | --------- | ------------------- |
| H1    | Jersey 25 | 40–56px, responsive |
| H2    | Jersey 20 | 28–36px, responsive |
| H3    | Jersey 15 | 28px                |
| H4    | Jersey 10 | 24px                |

Use `display` only for brand and marketing titles. `ui` keeps workspace headings compact:
32px for H1, 24px for lower-level headings. Repeated records and sidebars also use the compact
size; dialogs use 28px. These sizes come from the shared heading tokens in `foundations.css`.
Long titles wrap, including on narrow screens and with enlarged text.

Body copy, labels, input values, source strings, and translated strings use the system font. Keep
natural letter spacing, use `lang` and `dir` when the language is known, and let translation text
wrap with a 1.65 line height. Do not use Jersey for strings people review.

Spacing, font sizes, and motion durations live in `styles/foundations.css`. Status
colors always have a shape and label. Selected rows use a background and stronger text weight;
keyboard focus retains its visible outline. Shared styles include reduced-motion rules. Check the affected workflow with reduced motion
enabled; [accessibility review](testing.md#accessibility-review) describes the broader checks.

## Pixels and shapes

Corners are square throughout the interface. Icons use straight segments; status markers are
empty, half-filled, and checked squares. Shadows have a solid offset without blur. Switches and
choice controls keep native keyboard behavior inside square outlines.

`Wordmark` combines the Quaso cat with Jersey 25. `QuasoMascot` displays the same mark on its own.
The source is `packages/design-system/src/assets/quaso-cat.svg`, drawn on a **32×26** grid with nine colors.
It uses only pixel-aligned paths and `shape-rendering="crispEdges"`. Prefer the SVG at any
sizes; the 32×26 PNG and 768×624 nearest-neighbor PNG ship alongside it. Never smooth the sprite.

`PixelPattern` provides lime, mint, and plum variants of a repeating pixel weave. Use it in
brand banners and empty decorative areas, with stepped shapes if needed. Keep patterns
away from translation text, forms, tables, and other reading surfaces. Patterns are decorative
and hidden from assistive technology.

Controls share `--control-height`: 44px at the default font size, growing with larger text.
Small buttons reduce padding and type size without reducing the touch target. Wrap checkboxes,
radios, and switches in `Label` so the full row is a touch target, at least 44px high at the default text size. Multiline fields may grow
taller; single-line selects and inputs start at the same height on every device.

## Check a change

Check the affected examples in light and dark mode, then the real workflow that uses them. Check
narrow screens, keyboard focus, and long or right-to-left text when relevant. Targeted checks are:

```sh
npm run lint:react
npm run typecheck
npx vitest run packages/design-system
npx vitest run e2e/catalog.test.ts e2e/design_system.test.ts
npm run site:build
```

The Jersey fonts are distributed under the SIL Open Font License. Each font's license ships in
`packages/design-system/src/assets/Jersey-*-OFL.txt`. Both app and site builds copy these licenses
alongside the bundled fonts.
