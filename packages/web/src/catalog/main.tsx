// SPDX-License-Identifier: MIT
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "../lib/router.tsx";
import { initTheme } from "../lib/theme.ts";
import { ToastProvider } from "../design-system.ts";
import { Catalog } from "./Catalog.tsx";
import "../styles/theme.css";
import "../styles/base.css";
import "../styles/foundations.css";
import "../styles/components.css";
import "../styles/pages.css";
import "../styles/editor.css";
import "../styles/community.css";
import "./catalog.css";

initTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider>
      <ToastProvider>
        <Catalog />
      </ToastProvider>
    </RouterProvider>
  </StrictMode>,
);
