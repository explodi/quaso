// SPDX-License-Identifier: MIT
import type { ComponentProps, ReactNode } from "react";

type HeadingProps = ComponentProps<"h1"> & { display?: boolean; ui?: boolean };

function Heading({
  as: Tag,
  display,
  ui,
  className = "",
  children,
  ...props
}: HeadingProps & {
  as: "h1" | "h2" | "h3" | "h4";
}) {
  return (
    <Tag
      className={`heading${display ? " heading-display" : ""}${ui ? " heading-ui" : ""} ${className}`}
      {...props}
    >
      <span className="heading-ink">{children}</span>
    </Tag>
  );
}

export function H1(props: HeadingProps) {
  return <Heading as="h1" {...props} />;
}
export function H2(props: HeadingProps) {
  return <Heading as="h2" {...props} />;
}
export function H3(props: HeadingProps) {
  return <Heading as="h3" {...props} />;
}
export function H4(props: HeadingProps) {
  return <Heading as="h4" {...props} />;
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`}>
      <QuasoMascot decorative />
      <span>Quaso</span>
    </span>
  );
}

export function QuasoMascot({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <span
      className={`quaso-mascot ${className}`}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : "Quaso, a little gray cat in a golden croissant"}
    />
  );
}

export function PixelPattern({
  tone = "lime",
  className = "",
}: {
  tone?: "lime" | "mint" | "plum";
  className?: string;
}) {
  return <div className={`pixel-pattern pixel-pattern-${tone} ${className}`} aria-hidden="true" />;
}

export function Kbd({ children, ...props }: ComponentProps<"kbd"> & { children: ReactNode }) {
  return <kbd {...props}>{children}</kbd>;
}
