// SPDX-License-Identifier: MIT
import { test } from "node:test";
/** These probes ensure the CI gate rejects both state-update regressions. */
import { assert, assertEquals } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { ESLint } from "eslint";

const FRONTENDS = ["packages/design-system/src", "packages/web/src", "site/src"];

test("frontend lint gate rejects state updates in effects and render in both consumers and the library", async () => {
  const eslint = new ESLint({
    cwd: fromFileUrl(new URL("..", import.meta.url)),
    overrideConfigFile: fromFileUrl(new URL("../eslint.config.js", import.meta.url)),
  });
  for (const directory of FRONTENDS) {
    for (const [rule, body] of [
      ["set-state-in-effect", "useEffect(() => { setCount(1); }, []);"],
      ["set-state-in-render", "setCount(count + 1);"],
    ]) {
      const [result] = await eslint.lintText(
        `import { useState, useEffect } from 'react';
        export function Probe() { const [count, setCount] = useState(0);
          ${body} return <p>{count}</p>; }`,
        { filePath: `${directory}/LintProbe.tsx` },
      );
      assertEquals(result.fatalErrorCount, 0, "the probe must parse successfully");
      assert(result.messages.some((m) => m.ruleId === `react-hooks/${rule}` && m.severity === 2));
    }
    const [valid] = await eslint.lintText(
      `import { useState } from 'react';
      import { Button } from './Button.tsx';
      export function Probe() { const [count, setCount] = useState(0);
        return <Button onClick={() => setCount(count + 1)}>{count}</Button>; }`,
      { filePath: `${directory}/LintProbe.tsx` },
    );
    assertEquals(valid.errorCount, 0);
  }
});

test("native controls belong only in design-system primitive implementations", async () => {
  const eslint = new ESLint();
  for (const directory of FRONTENDS) {
    for (const tag of [
      "button",
      "input",
      "select",
      "textarea",
      "a",
      "label",
      "fieldset",
      "table",
      "progress",
      "details",
      "summary",
      "dialog",
      "h1",
      "kbd",
    ]) {
      const [raw] = await eslint.lintText(`export function Probe() { return <${tag} />; }`, {
        filePath: `${directory}/Probe.tsx`,
      });
      assert(
        raw.messages.some((message) => message.ruleId === "no-restricted-syntax"),
        `${directory}: ${tag}`,
      );
    }
    const [shared] = await eslint.lintText(
      'import { Radio } from "@quaso/design-system"; export function Probe() { return <Radio />; }',
      { filePath: `${directory}/Probe.tsx` },
    );
    // The package itself imports its primitives relatively.
    assertEquals(
      shared.messages.filter((message) => message.ruleId === "no-restricted-syntax"),
      [],
    );
  }
  const [primitive] = await eslint.lintText(
    'export function Button() { return <button type="button" />; }',
    { filePath: "packages/design-system/src/components/Button.tsx" },
  );
  assertEquals(primitive.errorCount, 0);
  const [adapter] = await eslint.lintText(
    'export function ButtonLink() { return <a href="/" />; }',
    { filePath: "packages/web/src/components/Button.tsx" },
  );
  assert(adapter.messages.some((message) => message.ruleId === "no-restricted-syntax"));
});

test("the design-system lint boundary rejects app and domain dependencies", async () => {
  const eslint = new ESLint();
  for (const source of [
    "@quaso/core",
    "@quaso/service",
    "@quaso/web/src/lib/router.tsx",
    "../../../web/src/lib/router.tsx",
    "../../../../site/src/Layout.tsx",
    "../../../../packages/core/mod.ts",
  ]) {
    const [result] = await eslint.lintText(`export { Probe } from "${source}";`, {
      filePath: "packages/design-system/src/components/Probe.tsx",
    });
    assert(
      result.messages.some((message) => message.ruleId === "no-restricted-imports"),
      source,
    );
  }
  const [valid] = await eslint.lintText('export { Button } from "./Button.tsx";', {
    filePath: "packages/design-system/src/components/Probe.tsx",
  });
  assertEquals(valid.errorCount, 0);
});

test("consumers use public package exports and the website cannot import app sources", async () => {
  const eslint = new ESLint();
  for (const directory of ["packages/web/src", "site/src"]) {
    for (const source of [
      "@quaso/design-system/src/components/Button.tsx",
      "../../design-system/src/components/Button.tsx",
      "../../packages/design-system/src/styles/theme.css",
      "../../packages/web/src/components/Button.tsx",
      "@quaso/web/src/design-system.ts",
    ]) {
      const [result] = await eslint.lintText(`export { Probe } from "${source}";`, {
        filePath: `${directory}/Probe.tsx`,
      });
      assert(
        result.messages.some((message) => message.ruleId === "no-restricted-imports"),
        source,
      );
    }
    const [valid] = await eslint.lintText('export { Button } from "@quaso/design-system";', {
      filePath: `${directory}/Probe.tsx`,
    });
    assertEquals(valid.errorCount, 0);
  }
});
