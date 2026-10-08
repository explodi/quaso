// SPDX-License-Identifier: MIT
import type { ComponentProps, ReactNode } from "react";

export interface NoticeProps extends ComponentProps<"div"> {
  kind?: "info" | "warning" | "success" | "error";
  title?: string;
  icon?: ReactNode;
}

/** A message box; callers choose live-region semantics when the message updates. */
export function Notice({ kind = "info", title, children, icon, className, ...props }: NoticeProps) {
  return (
    <div className={`notice notice-${kind}${className ? ` ${className}` : ""}`} {...props}>
      {icon && <span className="notice-icon">{icon}</span>}
      <div className="notice-body">
        {title && <p className="notice-title">{title}</p>}
        {children}
      </div>
    </div>
  );
}
