// SPDX-License-Identifier: MIT
/**
 * The website's entry point (design §5.9): a static React app that reads the API's address
 * from `/config.json` (§5.12), then renders. Meanwhile it asks whether the server is awake,
 * which starts a sleeping one, and asks again whenever the tab comes back into view or into focus, since
 * the server may have fallen asleep in the meantime. It runs under the server's Content
 * Security Policy: no inline scripts, no eval, and styles only from our stylesheet and style
 * attributes.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { configureApi } from "./lib/api.ts";
import { loadConfig } from "./lib/config.ts";
import { waitUntilAwake } from "./lib/wake.ts";
import { revalidateOnFocus } from "./lib/data.ts";
import { initTheme } from "@quaso/design-system";
import "@quaso/design-system/styles.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/editor.css";
import "./styles/community.css";
import "./styles/workspace.css";

initTheme();
revalidateOnFocus();
waitUntilAwake();
window.addEventListener("focus", () => waitUntilAwake());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") waitUntilAwake();
});

loadConfig().then((config) => {
  configureApi({ apiBase: config.apiBase });
  createRoot(document.getElementById("root")!).render(<App />);
});
