// SPDX-License-Identifier: MIT
/**
 * The development server's entry point (`bun run site`): renders the landing page in the
 * browser, with hot reloading. The published site doesn't use it: build.ts pre-renders the
 * same components to static HTML, without JavaScript.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./Layout.tsx";
import { Landing } from "./Landing.tsx";
import { HOME } from "./paths.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell page={HOME} section="home">
      <Landing page={HOME} />
    </Shell>
  </StrictMode>,
);
