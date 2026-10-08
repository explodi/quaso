# Quaso design system

The shared React components, styles, design tokens, theme preference, and brand assets used by
the application and public website. This workspace package has no dependency on the app,
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
| `@quaso/design-system/tokens`     | Colour primitives, semantic themes, and CSS generation                            |
| `@quaso/design-system/icons`      | SVG icons                                                                         |
| `@quaso/design-system/contrast`   | Colour contrast and perception calculations                                       |
| `@quaso/design-system/assets/*`   | Fonts, font licenses, mascot artwork, and the pixel pattern                       |

Import the shared stylesheet once, before a consumer's layout styles. Use semantic CSS
variables such as `--surface`, `--fg`, `--space-4`, and `--heading-2` in consumer layouts.
Update colours in `src/styles/tokens.ts`, then run `deno task design:tokens` from the repository
root to regenerate the checked-in theme CSS.

Native control wrappers preserve normal HTML attributes and browser behaviour. Interactive
components provide visible focus, keyboard navigation, accessible names, and reduced-motion
styles. `StateIcon` is decorative; pair it with readable text or use `ColourLabel`, which
includes both the shape and label. A `Notice` accepts native div attributes so consumers can
choose `role="alert"` or another live-region behaviour when appropriate.

Application routing and domain-aware compositions stay with their consumer. For example,
the app's `ButtonLink` adapts its router's link with the exported `buttonClassName` helper;
the website uses `AnchorButton`. Both receive the same button styles.

Jersey font licenses are distributed alongside the font files in `src/assets/`. The
application's `/design.html` catalog demonstrates the shared foundations and components
alongside the application's composed patterns.
