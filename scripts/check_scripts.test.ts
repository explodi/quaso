// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingHeaders } from "./check_headers.ts";
import { isAllowed } from "./check_licenses.ts";

test("licence expressions: permissive passes, copyleft fails", () => {
  for (const ok of ["MIT", "(MIT OR Apache-2.0)", "BSD-3-Clause", "ISC", "Apache-2.0 AND MIT"]) {
    expect(isAllowed(ok), ok).toBe(true);
  }
  for (const bad of [
    "GPL-3.0",
    "LGPL-2.1",
    "MPL-2.0",
    "AGPL-3.0",
    "MIT AND GPL-2.0",
    "",
    "UNLICENSED",
  ]) {
    expect(isAllowed(bad), bad).toBe(false);
  }
  expect(isAllowed("GPL-2.0 OR MIT")).toBe(true);
});

test("files without the SPDX header are reported", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-headers-"));
  try {
    const good = join(dir, "good.ts");
    const shebang = join(dir, "tool.ts");
    const bad = join(dir, "bad.ts");
    const other = join(dir, "notes.md");
    await fs.writeFile(good, "// SPDX-License-Identifier: MIT\nexport {};\n");
    await fs.writeFile(shebang, "#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\n");
    await fs.writeFile(bad, "export const x = 1;\n");
    await fs.writeFile(other, "no header needed\n");
    expect(await missingHeaders([good, shebang, bad, other])).toStrictEqual([bad]);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
