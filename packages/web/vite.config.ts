// SPDX-License-Identifier: MIT
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const server = process.env.QUASO_DEV_SERVER ?? "http://localhost:8000";
const resolveAsset = createRequire(import.meta.url).resolve;

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    {
      name: "quaso-font-licenses",
      async generateBundle() {
        for (const font of [10, 15, 20, 25]) {
          const name = `Jersey-${font}-OFL.txt`;
          this.emitFile({
            type: "asset",
            fileName: `fonts/${name}`,
            source: await readFile(resolveAsset(`@quaso/design-system/assets/${name}`), "utf8"),
          });
        }
      },
    },
  ],
  resolve: {
    alias: { "@quaso/core": new URL("../core/mod.ts", import.meta.url).pathname },
  },
  server: {
    port: Number(process.env.QUASO_WEB_PORT ?? 5173),
    proxy: {
      "/api": server,
      "/auth": server,
      "/healthz": server,
      "/schema": server,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rolldownOptions: { input: { app: "index.html", design: "design.html" } },
  },
});
