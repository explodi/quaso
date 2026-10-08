// SPDX-License-Identifier: MIT
/** `deno task cf:fixtures --check` passes on a checkout with CRLF line endings. */
import { describe, expect, it } from "vitest";
import { fixtureUpToDate, lf, withLf } from "../scripts/fixture_text.ts";

describe("cf:fixtures", () => {
  it("compares the fixture whatever its line endings", () => {
    const text = '{\n  "a": "x\\r\\ny"\n}\n';
    expect(fixtureUpToDate(text, text)).toBe(true);
    expect(fixtureUpToDate(text.replaceAll("\n", "\r\n"), text)).toBe(true);
    expect(fixtureUpToDate(text.replace("x", "z"), text)).toBe(false);
    expect(fixtureUpToDate("", text)).toBe(false);
  });

  it("reads the demo's files with LF", () => {
    expect(lf("a\r\nb\rc\n")).toBe("a\nb\rc\n");
    expect(withLf([{ path: "a.json", content: '{\r\n  "a": 1\r\n}\r\n' }])).toEqual([
      { path: "a.json", content: '{\n  "a": 1\n}\n' },
    ]);
  });
});
