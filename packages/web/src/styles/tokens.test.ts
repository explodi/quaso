// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
/**
 * The colours' accessibility (S7.9): theme.css is generated from tokens.ts, every text and
 * background pair has WCAG AA contrast in both themes, and the three state colours stay
 * apart for people with the common red–green colour blindnesses.
 */
import { assert, assertEquals } from "@std/assert";
import { colourDifference, contrastRatio, lightness, type Vision } from "../lib/contrast.ts";
import { CONTRAST_CHECKS, faviconSvg, THEME_CSS_URL, themeCss, THEMES } from "./tokens.ts";

test("theme.css is generated from tokens.ts", async () => {
  const css = await fs.readFile(THEME_CSS_URL, "utf8");
  assertEquals(css, themeCss(), "theme.css is out of date: run deno task design:tokens");
});

test("every colour pair has enough contrast in both themes (WCAG 2.2 AA)", () => {
  const failures: string[] = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const { fg, bg, min } of CONTRAST_CHECKS) {
      const ratio = contrastRatio(theme[fg], theme[bg]);
      if (ratio < min) {
        failures.push(`${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
      }
    }
  }
  assertEquals(failures, []);
});

test("the state colours stay apart with red–green colour blindness", () => {
  const visions: Vision[] = ["normal", "protanopia", "deuteranopia"];
  const pairs = [
    ["state-red", "state-green"],
    ["state-red", "state-blue"],
    ["state-green", "state-blue"],
  ] as const;
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const [a, b] of pairs) {
      for (const vision of visions) {
        const difference = colourDifference(theme[a], theme[b], vision);
        assert(
          difference >= 25,
          `${name}: ${a} and ${b} differ by ΔE ${difference.toFixed(1)} (${vision})`,
        );
      }
      // Lightness differs too, not only hue.
      const gap = Math.abs(lightness(theme[a]) - lightness(theme[b]));
      assert(gap >= 5, `${name}: ${a} and ${b} differ in lightness by only ${gap.toFixed(1)}`);
    }
  }
});

test("contrast arithmetic matches WCAG's examples", () => {
  assertEquals(contrastRatio("#000000", "#ffffff"), 21);
  assertEquals(contrastRatio("#fff", "#fff"), 1);
  assertEquals(Math.round(contrastRatio("#777777", "#ffffff") * 100) / 100, 4.48);
});

test("no stylesheet fades text: the contrast checks above would no longer hold", async () => {
  // Opacity below 1 mixes text with what's behind it, which CONTRAST_CHECKS can't see.
  // Disabled buttons (WCAG exempts inactive controls) and invisible inputs may use it.
  const allowed = [/:disabled\b/, /\.visually-hidden-input\b/];
  const failures: string[] = [];
  for (const name of ["base.css", "components.css", "pages.css", "editor.css"]) {
    const css = await fs.readFile(new URL(name, import.meta.url), "utf8");
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selector, body] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const opacity = /(?:^|[;\s])opacity:\s*([\d.]+)/.exec(body);
      if (!opacity) continue;
      const value = Number(opacity[1]);
      if (value === 0 || value >= 1) continue;
      if (allowed.some((pattern) => pattern.test(selector))) continue;
      failures.push(`${name}: ${selector.trim()} { opacity: ${value} }`);
    }
  }
  assertEquals(failures, []);
});

test("favicons use the shared brand palette", async () => {
  assertEquals(
    await fs.readFile(new URL("../../public/favicon.svg", import.meta.url), "utf8"),
    faviconSvg(),
  );
  assertEquals(
    await fs.readFile(new URL("../../../../site/public/favicon.svg", import.meta.url), "utf8"),
    faviconSvg(),
  );
});

test("authored stylesheets use palette variables instead of literal colors", async () => {
  const failures: string[] = [];
  const roots = [
    new URL("../", import.meta.url),
    new URL("../../../../site/src/", import.meta.url),
  ];
  for (const root of roots) {
    const files = await fs.readdir(root, { recursive: true });
    for (const file of files.filter(
      (name) => name.endsWith(".css") && name !== "styles/theme.css",
    )) {
      const css = await fs.readFile(new URL(file, root), "utf8");
      const literal = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\s*\(/i.exec(css);
      if (literal) failures.push(`${file}: ${literal[0]}`);
    }
  }
  assertEquals(failures, []);
});
