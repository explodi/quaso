// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleStylesheet } from "./styles.ts";

test("static site bundles public design-system CSS and all its self-hosted assets", async () => {
  const { css, assets } = await bundleStylesheet(new URL("./src/styles.css", import.meta.url));
  assert(!css.includes("@import"), "Published pages must not depend on package imports");
  expect(css).toContain("--font-display:");
  expect(css).toContain(".skip-link:focus");
  expect(css).toContain(".colour-label");
  for (const name of [
    "jersey-10.ttf",
    "jersey-15.ttf",
    "jersey-20.ttf",
    "jersey-25.ttf",
    "quaso-cat.svg",
    "pixel-weave.svg",
  ]) {
    const source = assets.get(name);
    assert(source, `${name} must be copied with the CSS`);
    assert((await stat(source)).size > 0);
    expect(css).toContain(`url("./${name}")`);
  }
  for (const font of [10, 15, 20, 25]) {
    const license = new URL(
      import.meta.resolve(`@quaso/design-system/assets/Jersey-${font}-OFL.txt`),
    );
    expect(await readFile(license, "utf8")).toContain("SIL OPEN FONT LICENSE");
  }
});

test("CSS assets resolve from nested imports and remain relative under a hosting prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quaso-site-css-"));
  try {
    await mkdir(join(directory, "nested"));
    await writeFile(
      join(directory, "main.css"),
      '@import "./nested/type.css";\nbody { margin: 0; }',
    );
    await writeFile(
      join(directory, "nested/type.css"),
      '@import "./brand.css";\n@font-face { src: url("./pixel font.ttf?v=1#face"); }',
    );
    await writeFile(
      join(directory, "nested/brand.css"),
      '.brand { background: url("./mascot.svg"); mask: url("data:image/svg+xml;base64,PHN2Zy8+"); }',
    );
    const { css, assets } = await bundleStylesheet(pathToFileURL(join(directory, "main.css")));
    expect(css).toContain('url("./pixel%20font.ttf?v=1#face")');
    expect(css).toContain('url("./mascot.svg")');
    expect(css).toContain('url("data:image/svg+xml;base64,PHN2Zy8+")');
    assert(!css.includes("@import"));
    expect(assets.get("pixel font.ttf")?.href).toStrictEqual(
      pathToFileURL(join(directory, "nested/pixel font.ttf")).href,
    );
    const mascotUrl = /background: url\("([^"]+)"\)/.exec(css)![1];
    expect(new URL(mascotUrl, "https://example.test/quaso/assets/site.css").pathname).toStrictEqual(
      "/quaso/assets/mascot.svg",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("CSS bundling rejects conflicting asset names instead of overwriting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quaso-site-css-"));
  try {
    await mkdir(join(directory, "nested"));
    await writeFile(
      join(directory, "main.css"),
      '@import "./nested/type.css";\n.brand { background: url("./mascot.svg"); }',
    );
    await writeFile(
      join(directory, "nested/type.css"),
      '.brand { background: url("./mascot.svg"); }',
    );
    await expect(bundleStylesheet(pathToFileURL(join(directory, "main.css")))).rejects.toThrow(
      "CSS assets share the output filename mascot.svg",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
