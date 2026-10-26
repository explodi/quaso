// SPDX-License-Identifier: MIT
/**
 * A progress bar (design §5.9), dithered from full to empty like the state squares: solid blue
 * for proofread words, a green checkerboard for translated words not yet proofread, sparse dots
 * for the untranslated rest. The bar is an image with a text alternative: "45% translated •
 * 10% proofread".
 */
import type { Progress } from "@quaso/core";
import { progressText } from "../lib/format.ts";

export function ProgressBar({
  progress,
  size = "medium",
  label,
}: {
  progress: Pick<Progress, "translatedPercent" | "proofreadPercent">;
  size?: "small" | "medium";
  label?: string;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const blue = clamp(progress.proofreadPercent);
  const green = clamp(progress.translatedPercent - blue);
  const text = label ?? progressText(progress);
  return (
    <div className={`bar bar-${size}`} role="img" aria-label={text} title={text}>
      {blue > 0 && <span className="bar-part bar-blue" style={{ width: `${blue}%` }} />}
      {green > 0 && <span className="bar-part bar-green" style={{ width: `${green}%` }} />}
      <span className="bar-part bar-rest" />
    </div>
  );
}
