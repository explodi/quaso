// SPDX-License-Identifier: MIT
/** A text-only word diff; bounded memory even for very long translation proposals. */
export interface DiffPart {
  text: string;
  kind: "same" | "added" | "removed";
}

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.match(/\s+|[^\s]+/gu) ?? [];
  const b = after.match(/\s+|[^\s]+/gu) ?? [];
  const result: DiffPart[] = [];
  const append = (text: string, kind: DiffPart["kind"]) => {
    if (!text) return;
    if (result.at(-1)?.kind === kind) result[result.length - 1].text += text;
    else result.push({ text, kind });
  };
  // Keep huge strings responsive; their common prefix/suffix still get a useful diff.
  if (a.length * b.length > 250_000) {
    let start = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
    let end = 0;
    while (
      end < Math.min(a.length, b.length) - start &&
      a[a.length - end - 1] === b[b.length - end - 1]
    )
      end++;
    append(a.slice(0, start).join(""), "same");
    append(a.slice(start, a.length - end).join(""), "removed");
    append(b.slice(start, b.length - end).join(""), "added");
    append(a.slice(a.length - end).join(""), "same");
    return result;
  }
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      append(a[i++], "same");
      j++;
    } else if (
      i < a.length &&
      (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    )
      append(a[i++], "removed");
    else append(b[j++], "added");
  }
  return result;
}
