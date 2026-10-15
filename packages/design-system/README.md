# Quaso design system

This package supplies shared React components, styles, color and spacing values, theme settings,
and brand assets for the application and public website. This workspace package has no dependency on the app,
its router, or the domain model.

```tsx
import { AnchorButton, H1, ThemeSwitch } from "@quaso/design-system";
import "@quaso/design-system/styles.css";
import "./styles.css";

export function Welcome() {
  return (
    <main>
      <H1>Translate together</H1>
      <ThemeSwitch variant="menu" />
      <AnchorButton href="/docs/" variant="primary">
        Read the docs
      </AnchorButton>
    </main>
  );
}
```

Call `initTheme()` before rendering in the browser to apply the saved appearance preference.
`ThemeSwitch` offers a select, a switch, and a menu; `useTheme()` and `useDarkTheme()` expose
the same preference to custom presentations.

## Public entry points

| Import                            | Contents                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `@quaso/design-system`            | Components, icons, translation-state presentation, and theme helpers              |
| `@quaso/design-system/styles.css` | Theme, reset, focus and accessibility utilities, typography, and component styles |
| `@quaso/design-system/tokens`     | Color values, theme roles, and CSS generation                                     |
| `@quaso/design-system/icons`      | SVG icons                                                                         |
| `@quaso/design-system/contrast`   | Color contrast and perception calculations                                        |
| `@quaso/design-system/assets/*`   | Fonts, font licenses, mascot artwork, and the pixel pattern                       |

Import the shared stylesheet once, before the app or site's layout styles. Use named CSS
variables such as `--surface`, `--fg`, `--space-4`, and `--heading-2` in app or site layouts.
Update colors in `src/styles/tokens.ts`, then run `deno task design:tokens` from the repository
root to generate again the checked-in theme CSS.

Control components pass through normal HTML attributes and browser behavior. Shared styles and
components support keyboard focus and reduced motion. Give each control a label and check it in
its actual page; using the package alone does not prove accessibility. `StateIcon` is decorative; pair it with readable text or use `ColourLabel`, which
includes both the shape and label. A `Notice` accepts native div attributes so callers can
choose `role="alert"` or another live-region behavior when appropriate.

Application routing and components that know about translation data stay with their app or site. For example,
the app's `ButtonLink` adapts its router's link with the exported `buttonClassName` helper;
the website uses `AnchorButton`. Both receive the same button styles.

Jersey font licenses are distributed alongside the font files in `src/assets/`. The
application's `/design.html` catalog demonstrates the shared foundations and components
alongside the application's composed patterns.

See the [design-system guide](../../docs/contributing/design-system.md) for styling rules and checks.
