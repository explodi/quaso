// SPDX-License-Identifier: MIT
import { test } from "node:test";
/** These probes ensure the CI gate rejects both state-update regressions. */
import { assert, assertEquals } from "@quaso/runtime/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { ESLint } from "eslint";

test("frontend lint gate rejects state updates in effects and render in both frontends", async () => {
  const eslint = new ESLint({
    cwd: fromFileUrl(new URL("..", import.meta.url)),
    overrideConfigFile: fromFileUrl(new URL("../eslint.config.js", import.meta.url)),
  });
  for (const directory of ["packages/web/src", "site/src"]) {
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
      import { Button } from './components/Button.tsx';
      export function Probe() { const [count, setCount] = useState(0);
        return <Button onClick={() => setCount(count + 1)}>{count}</Button>; }`,
      { filePath: `${directory}/LintProbe.tsx` },
    );
    assertEquals(valid.errorCount, 0);
  }
});

test("the frontend gate requires catalog components for native controls", async () => {
  const eslint = new ESLint();
  const [raw] = await eslint.lintText(
    'export function Probe() { return <input type="radio" />; }',
    { filePath: "packages/web/src/Probe.tsx" },
  );
  assertEquals(raw.messages[0]?.ruleId, "no-restricted-syntax");
  const [shared] = await eslint.lintText(
    'import { Radio } from "./design-system.ts"; export function Probe() { return <Radio />; }',
    { filePath: "packages/web/src/Probe.tsx" },
  );
  assertEquals(shared.errorCount, 0);
});
