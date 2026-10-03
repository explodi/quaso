// SPDX-License-Identifier: MIT
/**
 * Vite, for `bun run site`: a development server for the landing page, with hot
 * reloading (src/main.tsx renders it in the browser).
 *
 * The documentation pages exist only in the built site: build.ts (`bun run site:build`)
 * renders the Markdown in docs/ to site/dist/, together with the landing page, and
 * `bun run site:preview` builds the site and serves site/dist/ with `vite preview`.
 * The published site doesn't come from `vite build`: it ships no JavaScript.
 */
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // A 404 for missing pages, such as the documentation, instead of the landing page.
  appType: "mpa",
  optimizeDeps: { entries: ["index.html"] },
  build: { outDir: "dist" },
});
