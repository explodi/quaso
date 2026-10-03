// SPDX-License-Identifier: MIT
/**
 * The website's entry point (design §5.9): a static React app that reads the API's address
 * from `/config.json` (§5.12), then renders. It runs under the server's Content Security
 * Policy: no inline scripts, no eval, and styles only from our stylesheet and style
 * attributes.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { configureApi } from "./lib/api.ts";
import { loadConfig } from "./lib/config.ts";
import { revalidateOnFocus } from "./lib/data.ts";
import { initTheme } from "./lib/theme.ts";
import "./styles/theme.css";
import "./styles/base.css";
import "./styles/foundations.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/editor.css";
import "./styles/community.css";

initTheme();
revalidateOnFocus();

loadConfig().then((config) => {
  configureApi({ apiBase: config.apiBase });
  createRoot(document.getElementById("root")!).render(<App />);
});
