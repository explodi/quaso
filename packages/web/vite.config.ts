// SPDX-License-Identifier: MIT
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

const server = process.env.QUASO_DEV_SERVER ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: { "@quaso/core": new URL("../core/mod.ts", import.meta.url).pathname },
  },
  server: {
    port: Number(process.env.QUASO_WEB_PORT ?? 5173),
    proxy: {
      "/api": server,
      "/auth": server,
      "/config.json": server,
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
