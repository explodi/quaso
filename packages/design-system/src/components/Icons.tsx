// SPDX-License-Identifier: MIT
/**
 * Inline SVG icons (no icon font, nothing fetched). They are decorative: whatever they say
 * is also written in text next to them or in the control's label.
 */
import type { ReactNode } from "react";

interface IconProps {
  className?: string;
  size?: number;
}

function Svg({ className, size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

// --- String states: shapes that differ without colour.

/** Untranslated: an empty square. */
export function EmptySquareIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="12" height="12" strokeWidth="2" />
    </Svg>
  );
}

/** Translated (green): a half-filled square. */
export function HalfSquareIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="12" height="12" strokeWidth="2" />
      <path d="M2 2h6v12H2z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Proofread (blue): a square with a check. */
export function CheckSquareIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="12" height="12" strokeWidth="2" />
      <path d="M5.2 8.2 7.2 10.2 10.9 6" strokeWidth="2" />
    </Svg>
  );
}

/** Outdated: a clock. */
export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 2h6v1h2v2h1v6h-1v2h-2v1H5v-1H3v-2H2V5h1V3h2z" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Svg>
  );
}

/** Pending: an hourglass. */
export function HourglassIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 2h10M3 14h10M4 2v3l3 3-3 3v3M12 2v3L9 8l3 3v3" />
    </Svg>
  );
}

/** QA problems and errors: a warning triangle. */
export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 1.8 15 14H1z" />
      <path d="M8 6v3.6M8 11.6v.1" strokeWidth="1.8" />
    </Svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 2h6v1h2v2h1v6h-1v2h-2v1H5v-1H3v-2H2V5h1V3h2z" />
      <path d="M8 7.2v4M8 4.8v.1" strokeWidth="1.8" />
    </Svg>
  );
}

// --- Interface.

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 2h6v2h2v6h-2v2H4v-2H2V4h2z" />
      <path d="m10.5 10.5 3.5 3.5" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="5" width="6" height="6" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 2H4v2H2v7h2v2h2v1h5v-2h2V9h-3V8H8V6H7z" />
    </Svg>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" />
      <path d="M5.5 14h5M8 11v3" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 3h4v2h8v8H2z" />
    </Svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" />
      <path d="M9 1.75V5.5h3.75" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3 8.5 3.2 3.2L13 5" strokeWidth="1.8" />
    </Svg>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1" y="3.5" width="14" height="9" />
      <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7" strokeWidth="1.6" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" />
      <path d="M11 5V2H2v9h3" />
    </Svg>
  );
}

/** The LLM: sparkles. */
export function SparklesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 2.5 7.2 5.8 10.5 7 7.2 8.2 6 11.5 4.8 8.2 1.5 7l3.3-1.2zM12 9.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </Svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 2h4v1h1v5H5V3h1z" />
      <path d="M2 14v-2h2v-2h8v2h2v2" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8H3M7 4 3 8l4 4" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.75 9.75h6.5L12 4" />
    </Svg>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3 2 6l3 3" />
      <path d="M3 6h8v1h2v5h-2v1H6" />
    </Svg>
  );
}

export function GitHubIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M4 1v2H2v2H1v6h2v2h3v2h4v-2h3v-2h2V5h-1V3h-2V1h-2v2H6V1zM4 6h3v3H4zm5 0h3v3H9z"
        fillRule="evenodd"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 2h12v9H7v1H6v1H4v-2H2z" />
      <path d="M5.5 7h.01M8 7h.01M10.5 7h.01" strokeWidth="1.8" />
    </Svg>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" />
      <path d="m2 4 6 4.75L14 4" />
    </Svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v3h11v-3" />
    </Svg>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />
    </Svg>
  );
}

export function LogoIcon({ className = "", size = 32 }: IconProps) {
  return (
    <span
      className={`icon quaso-mascot ${className}`}
      style={{ width: size * 1.4, height: size }}
      aria-hidden="true"
    />
  );
}
