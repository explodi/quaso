// SPDX-License-Identifier: MIT
import { writeFile } from "node:fs/promises";
import { faviconSvg, THEME_CSS_URL, themeCss } from "@quaso/design-system/tokens";

await writeFile(THEME_CSS_URL, themeCss());
await writeFile(new URL("../packages/web/public/favicon.svg", import.meta.url), faviconSvg());
await writeFile(new URL("../site/public/favicon.svg", import.meta.url), faviconSvg());
console.log(`Wrote ${THEME_CSS_URL.pathname}`);
