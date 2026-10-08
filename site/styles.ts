// SPDX-License-Identifier: MIT
/** Static CSS bundling: keep the site JavaScript-free and its assets relative at any base path. */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export interface StylesheetBundle {
  css: string;
  /** Files copied beside the resulting stylesheet, keyed by output filename. */
  assets: Map<string, URL>;
}

/**
 * Resolve the design system through its public CSS export, including nested local imports.
 * Each asset URL is resolved against its original stylesheet before being made relative to
 * the output CSS. This works for both Vite development and pre-rendered, nested doc pages.
 */
export async function bundleStylesheet(entry: URL): Promise<StylesheetBundle> {
  const assets = new Map<string, URL>();
  const reading = new Set<string>();

  async function read(source: URL): Promise<string> {
    if (reading.has(source.href)) throw new Error(`Circular CSS import: ${source.href}`);
    reading.add(source.href);
    let css = await readFile(source, "utf8");
    // Rebase before expanding imports: imported files use their own source directory.
    css = css.replace(/url\(\s*(["']?)([^"'()]+)\1\s*\)/g, (match, _quote, value: string) => {
      const path = value.trim();
      if (/^(?:[a-z][\w+.-]*:|\/|#)/i.test(path)) return match;
      const asset = new URL(path, source);
      const suffix = asset.search + asset.hash;
      asset.search = "";
      asset.hash = "";
      const name = basename(fileURLToPath(asset));
      const existing = assets.get(name);
      if (existing && existing.href !== asset.href) {
        throw new Error(`CSS assets share the output filename ${name}`);
      }
      assets.set(name, asset);
      return `url("./${encodeURIComponent(name)}${suffix}")`;
    });
    for (const [directive, path] of css.matchAll(/@import\s+["']([^"']+)["']\s*;/g)) {
      const imported = path.startsWith(".")
        ? new URL(path, source)
        : new URL(import.meta.resolve(path));
      css = css.replace(directive, await read(imported));
    }
    reading.delete(source.href);
    return css;
  }

  return { css: await read(entry), assets };
}
