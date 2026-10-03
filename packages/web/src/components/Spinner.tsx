// SPDX-License-Identifier: MIT
/** A loading indicator; with reduced motion it doesn't spin (styles/base.css). */

/** Decorative: for buttons that also say they are busy. */
export function SpinnerIcon() {
  return <span className="spinner" aria-hidden="true" />;
}

/** A spinner with a label, announced politely to screen readers. */
export function Spinner({
  label = "Loading…",
  visibleLabel = true,
}: {
  label?: string;
  visibleLabel?: boolean;
}) {
  return (
    <span className="spinner-wrap" role="status">
      <SpinnerIcon />
      <span className={visibleLabel ? "spinner-label" : "sr-only"}>{label}</span>
    </span>
  );
}

/** A spinner in the middle of an area that is loading. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner label={label} />
    </div>
  );
}
