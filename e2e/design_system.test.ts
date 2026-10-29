// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assert, expect } from "vitest";
import { serve } from "../packages/server/src/http/serve.ts";
import { createWebHandler } from "../packages/server/src/static.ts";
import { browserTest, openTab, ROOT, type Tab } from "./_setup.ts";

browserTest(
  "the app, catalog, and static website share the design system across themes and screen sizes",
  { seed: true },
  async ({ server, browser }) => {
    const build = spawnSync("npm", ["run", "site:build"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    });
    assert(build.status === 0, "the static website must build using package exports");
    const handle = createWebHandler(join(ROOT, "site/dist"));
    const website = await serve({ hostname: "127.0.0.1", port: 0 }, handle);
    const site = { url: `http://127.0.0.1:${website.port}` };
    const tabs: Tab[] = [];
    try {
      for (const [host, path] of [
        [server, "/signin"],
        [server, "/design.html"],
        [site, "/"],
        [site, "/docs/contributing/design-system.html"],
      ] as const) {
        const tab = await openTab(browser, host, path, async (page) => {
          await page.setViewport({ width: 1440, height: 1000 });
          if (host === site) await page.setJavaScriptEnabled(false);
        });
        tabs.push(tab);
      }
      for (const theme of ["light", "dark"]) {
        const samples = [];
        for (const { page } of tabs) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await page.evaluate(() => document.fonts.ready);
          samples.push(
            await page.evaluate(() => {
              const body = getComputedStyle(document.body);
              const heading = getComputedStyle(document.querySelector("h1")!);
              const button = document.querySelector(".btn-primary");
              const control = button ? getComputedStyle(button) : null;
              return {
                body: {
                  color: body.color,
                  background: body.backgroundColor,
                  font: body.fontFamily,
                },
                headingFont: heading.fontFamily,
                button: control && {
                  color: control.color,
                  background: control.backgroundColor,
                  border: control.borderColor,
                  radius: control.borderRadius,
                  font: control.fontFamily,
                  minHeight: control.minHeight,
                },
                loadedFonts: document.fonts.check('400 32px "Jersey 25"'),
              };
            }),
          );
          for (const width of [360, 768, 1440]) {
            await page.setViewport({ width, height: 1000 });
            assert(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              `${page.url()} should fit ${width}px in ${theme} mode`,
            );
          }
          await page.addStyleTag({ content: "html { font-size: 200%; }" });
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${page.url()} should fit enlarged text in ${theme} mode`,
          );
          await page.evaluate(() => document.head.querySelector("style:last-of-type")?.remove());
        }
        for (const sample of samples) {
          expect(sample.body, `shared body styles in ${theme} mode`).toStrictEqual(samples[0].body);
          expect(sample.headingFont, `shared heading font in ${theme} mode`).toStrictEqual(
            samples[0].headingFont,
          );
          assert(sample.loadedFonts, "packaged Jersey font loads successfully");
        }
        assert(samples[0].button && samples[1].button && samples[2].button);
        expect(samples[1].button, `catalog buttons in ${theme} mode`).toStrictEqual(
          samples[0].button,
        );
        expect(samples[2].button, `website buttons in ${theme} mode`).toStrictEqual(
          samples[0].button,
        );
      }
      for (const tab of tabs) expect(tab.problems, tab.page.url()).toStrictEqual([]);
    } finally {
      await website.shutdown();
    }
  },
);
