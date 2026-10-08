// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("./", import.meta.url));

test("the design-system source and assets are independent of its consumers", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("package.json", import.meta.url), "utf8"));
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  assertEquals(
    [...dependencies].filter((name) => name.startsWith("@quaso/")),
    [],
  );
  const files = await fs.readdir(new URL("src/", import.meta.url), { recursive: true });
  const failures: string[] = [];
  for (const name of files.filter(
    (name) => /\.(tsx?|css)$/.test(name) && !name.endsWith(".test.ts"),
  )) {
    const path = resolve(ROOT, "src", name);
    const source = await fs.readFile(path, "utf8");
    const imports: string[] = [];
    if (name.endsWith(".css")) {
      for (const match of source.matchAll(/(?:@import\s+["']|url\(\s*["']?)([^"'\s)]+)/g)) {
        if (!match[1].startsWith("data:")) imports.push(match[1]);
      }
    } else {
      const module = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteral(node.arguments[0])
        )
          imports.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
      };
      visit(module);
    }
    for (const specifier of imports) {
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(path), specifier);
        if (!target.startsWith(ROOT))
          failures.push(`${name}: reaches outside the package: ${specifier}`);
        else assert((await fs.stat(target)).isFile(), `${name}: missing ${specifier}`);
      } else {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!dependencies.has(packageName))
          failures.push(`${name}: undeclared dependency: ${specifier}`);
      }
    }
  }
  assertEquals(failures, []);
});
