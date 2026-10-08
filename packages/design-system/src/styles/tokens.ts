// SPDX-License-Identifier: MIT
/** Palette shades are the only color literals; semantic roles choose a shade for each theme. */
export const PALETTE = {
  paper: {
    0: "#ffffff",
    50: "#f4f4f1",
    100: "#eeebf1",
    200: "#d7d0de",
    300: "#c4b6ce",
    400: "#93829f",
    500: "#74657f",
    600: "#62546c",
  },
  ink: {
    500: "#594366",
    600: "#493257",
    700: "#3b2648",
    800: "#30173d",
    900: "#291634",
    950: "#261230",
  },
  lime: { 50: "#f0f7dc", 300: "#e3ff97", 400: "#d7ff64", 500: "#c5ee50", 700: "#546b16" },
  mint: { 50: "#e7faf5", 300: "#80e5dc", 700: "#18665e", 950: "#163a38" },
  vermilion: {
    50: "#fdeceb",
    300: "#ffa36f",
    400: "#f7703f",
    500: "#c23b09",
    600: "#ad4424",
    700: "#b42318",
    950: "#3a1714",
  },
  amber: { 50: "#fff4d9", 300: "#e8b14a", 700: "#8a5300", 950: "#33260c" },
  teal: {
    50: "#e7f6ed",
    200: "#62e3c6",
    300: "#56d38c",
    700: "#116a3a",
    800: "#00665a",
    950: "#10291b",
  },
  blue: {
    50: "#e8effd",
    200: "#86a9f8",
    300: "#6cb6ff",
    600: "#0b62d6",
    700: "#0a54b4",
    800: "#1d3794",
    950: "#1d2d4a",
  },
  violet: { 50: "#ede7ff", 200: "#cdbdff", 700: "#4b2aa8", 950: "#2f2552" },
} as const;

const p = PALETTE;

export const TOKENS = [
  /** The page's background. */
  "brand",
  "brand-soft",
  "accent",
  "accent-alt",
  "accent-fg",
  "bg",
  /** Cards, panes, the header, inputs. */
  "surface",
  /** Toolbars, table headers, code. */
  "surface-alt",
  "hover",
  /** The selected row. */
  "selected",
  "fg",
  "fg-muted",
  /** Decorative lines. */
  "border",
  /** Lines that must be seen: inputs' borders (3:1). */
  "border-strong",
  "link",
  "focus",
  "primary",
  "primary-hover",
  "primary-fg",
  "danger",
  "danger-bg",
  "warning",
  "warning-bg",
  "success",
  "success-bg",
  "state-red",
  "state-green",
  "state-blue",
  /** The untranslated rest of a progress bar. */
  "bar-track",
  /** Highlighted placeholders in text. */
  "mark-bg",
  "mark-fg",
  "shadow",
  "backdrop",
] as const;

export type Token = (typeof TOKENS)[number];
export type Theme = Record<Token, string>;

export const LIGHT: Theme = {
  brand: p.ink[950],
  "brand-soft": p.lime[50],
  accent: p.lime[400],
  "accent-alt": p.mint[300],
  "accent-fg": p.ink[950],
  bg: p.paper[50],
  surface: p.paper[0],
  "surface-alt": p.paper[100],
  hover: p.paper[100],
  selected: p.lime[50],
  fg: p.ink[950],
  "fg-muted": p.paper[600],
  border: p.paper[200],
  "border-strong": p.paper[400],
  link: p.violet[700],
  focus: p.violet[700],
  primary: p.lime[400],
  "primary-hover": p.lime[500],
  "primary-fg": p.ink[950],
  danger: p.vermilion[700],
  "danger-bg": p.vermilion[50],
  warning: p.amber[700],
  "warning-bg": p.amber[50],
  success: p.teal[700],
  "success-bg": p.teal[50],
  "state-red": p.vermilion[500],
  "state-green": p.teal[800],
  "state-blue": p.blue[800],
  "bar-track": p.paper[200],
  "mark-bg": p.violet[50],
  "mark-fg": p.violet[700],
  shadow: "4px 4px 0 var(--border)",
  backdrop: "color-mix(in srgb, var(--ink-950) 48%, transparent)",
};

export const DARK: Theme = {
  brand: p.lime[400],
  "brand-soft": p.ink[800],
  accent: p.lime[400],
  "accent-alt": p.mint[300],
  "accent-fg": p.ink[950],
  bg: p.ink[950],
  surface: p.ink[900],
  "surface-alt": p.ink[800],
  hover: p.ink[700],
  selected: p.blue[950],
  fg: p.paper[50],
  "fg-muted": p.paper[300],
  border: p.ink[600],
  "border-strong": p.paper[400],
  link: p.mint[300],
  focus: p.mint[300],
  primary: p.lime[400],
  "primary-hover": p.lime[300],
  "primary-fg": p.ink[950],
  danger: p.vermilion[300],
  "danger-bg": p.vermilion[950],
  warning: p.amber[300],
  "warning-bg": p.amber[950],
  success: p.teal[300],
  "success-bg": p.teal[950],
  "state-red": p.vermilion[400],
  "state-green": p.teal[200],
  "state-blue": p.blue[200],
  "bar-track": p.ink[600],
  "mark-bg": p.violet[950],
  "mark-fg": p.violet[200],
  shadow: "4px 4px 0 var(--ink-950)",
  backdrop: "color-mix(in srgb, var(--ink-950) 72%, transparent)",
};

export interface ContrastCheck {
  fg: Token;
  bg: Token;
  /** 4.5 for text (WCAG 1.4.3), 3 for icons, focus rings and input borders (1.4.11). */
  min: number;
}

const TEXT_BACKGROUNDS: Token[] = ["bg", "surface", "surface-alt", "hover", "selected"];

/** Every pair of colours the website puts on top of each other, with its minimum contrast. */
export const CONTRAST_CHECKS: ContrastCheck[] = [
  ...(
    ["brand", "fg", "fg-muted", "link", "state-red", "state-green", "state-blue"] as Token[]
  ).flatMap((fg) => TEXT_BACKGROUNDS.map((bg) => ({ fg, bg, min: 4.5 }))),
  { fg: "danger", bg: "surface", min: 4.5 },
  { fg: "danger", bg: "danger-bg", min: 4.5 },
  { fg: "warning", bg: "surface", min: 4.5 },
  { fg: "warning", bg: "warning-bg", min: 4.5 },
  { fg: "success", bg: "surface", min: 4.5 },
  { fg: "success", bg: "success-bg", min: 4.5 },
  { fg: "fg", bg: "danger-bg", min: 4.5 },
  { fg: "fg", bg: "warning-bg", min: 4.5 },
  { fg: "fg", bg: "success-bg", min: 4.5 },
  { fg: "primary-fg", bg: "primary", min: 4.5 },
  { fg: "primary-fg", bg: "primary-hover", min: 4.5 },
  { fg: "accent-fg", bg: "accent", min: 4.5 },
  { fg: "accent-fg", bg: "accent-alt", min: 4.5 },
  { fg: "mark-fg", bg: "mark-bg", min: 4.5 },
  { fg: "focus", bg: "surface", min: 3 },
  { fg: "focus", bg: "bg", min: 3 },
  { fg: "border-strong", bg: "surface", min: 3 },
  { fg: "state-green", bg: "bar-track", min: 3 },
  { fg: "state-blue", bg: "bar-track", min: 3 },
];

export const THEMES = { light: LIGHT, dark: DARK };

const shades = Object.entries(PALETTE).flatMap(([family, values]) =>
  Object.entries(values).map(([shade, value]) => ({ name: `${family}-${shade}`, value })),
);

function declarations(theme: Theme, indent: string): string {
  return TOKENS.map((token) => {
    const shade = shades.find(({ value }) => value === theme[token]);
    const value = shade ? `var(--${shade.name})` : theme[token];
    return `${indent}--${token}: ${value};`;
  }).join("\n");
}

/** The content of `theme.css`. */
export function themeCss(): string {
  return `/* SPDX-License-Identifier: MIT */
/*
 * The theme's colours. Generated from tokens.ts: change them there, then run
 * deno task design:tokens
 * The light theme is the default; the dark one follows the system setting unless the
 * visitor picked a theme (data-theme on <html>).
 */

:root {
${shades.map(({ name, value }) => `  --${name}: ${value};`).join("\n")}
  color-scheme: light;
${declarations(LIGHT, "  ")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${declarations(DARK, "    ")}
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
${declarations(DARK, "  ")}
}
`;
}

export const THEME_CSS_URL = new URL("./theme.css", import.meta.url);

export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">
  <path d="M6 4h20v2h4v18h-4v4H6v-4H2V8h4z" fill="${p.ink[950]}"/>
  <path d="M6 6h20v2h2v14h-4v4H8v-4H4V10h2z" fill="${p.amber[300]}"/>
  <path d="M8 6h3v4H8v8H5v-7h3zm14 0h3v8h-3zm2 12h4v4h-4zM8 23h16v3H8z" fill="${p.amber[700]}"/>
  <path d="M10 9h3v3h6V9h3v3h2v10h-4v2h-8v-2H8V12h2z" fill="${p.paper[300]}"/>
  <path d="M12 17h8v5h-8z" fill="${p.paper[50]}"/>
  <path d="M10 14h3v3h-3zm9 0h3v3h-3zm-4 4h2v2h-2z" fill="${p.ink[950]}"/>
</svg>
`;
}
