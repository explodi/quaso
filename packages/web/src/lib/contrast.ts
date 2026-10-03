// SPDX-License-Identifier: MIT
/**
 * Colour arithmetic for the accessibility tests (design §8, S7.9): WCAG 2 contrast ratios,
 * colour-vision deficiency simulation and colour differences.
 */

export type Rgb = [number, number, number];

/** `#rrggbb` or `#rgb` to 0–255 channels. */
export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Not a hex colour: ${hex}`);
  let digits = match[1];
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join("");
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

/** An sRGB channel (0–255) to linear light (0–1). */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearRgb(hex: string): Rgb {
  return parseHex(hex).map(toLinear) as Rgb;
}

/** WCAG 2 relative luminance. */
export function relativeLuminance(hex: string): number {
  return luminanceOf(linearRgb(hex));
}

function luminanceOf([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export type Vision = "normal" | "protanopia" | "deuteranopia";

/**
 * Dichromat simulation in linear RGB (Viénot, Brettel and Mollon, 1999): how people without
 * L cones (protanopia) or M cones (deuteranopia) see a colour. These are the common
 * red–green colour blindnesses; milder forms (anomalous trichromacy) see more than this.
 */
const SIMULATION: Record<Exclude<Vision, "normal">, number[][]> = {
  protanopia: [
    [0.11238, 0.88762, 0],
    [0.11238, 0.88762, 0],
    [0.00401, -0.00401, 1],
  ],
  deuteranopia: [
    [0.29275, 0.70725, 0],
    [0.29275, 0.70725, 0],
    [-0.02234, 0.02234, 1],
  ],
};

function simulate(rgb: Rgb, vision: Vision): Rgb {
  if (vision === "normal") return rgb;
  const m = SIMULATION[vision];
  return m.map((row) =>
    Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])),
  ) as Rgb;
}

/** CIELAB (D65) from linear RGB. */
function lab([r, g, b]: Rgb): Rgb {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIELAB lightness (0–100) of a colour as someone with the given vision sees it. */
export function lightness(hex: string, vision: Vision = "normal"): number {
  return lab(simulate(linearRgb(hex), vision))[0];
}

/**
 * The CIE76 colour difference (ΔE*ab) between two colours as someone with the given vision
 * sees them. About 2 is just noticeable; above 20 the colours read as different.
 */
export function colourDifference(a: string, b: string, vision: Vision = "normal"): number {
  const [l1, a1, b1] = lab(simulate(linearRgb(a), vision));
  const [l2, a2, b2] = lab(simulate(linearRgb(b), vision));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
