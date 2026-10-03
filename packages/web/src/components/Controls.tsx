// SPDX-License-Identifier: MIT
import type { ComponentProps } from "react";

function classes(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={classes("input", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={classes("select", className)} {...props} />;
}

export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return <input className={classes("choice-input", className)} {...props} type="checkbox" />;
}

export function Radio({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return <input className={classes("choice-input", className)} {...props} type="radio" />;
}

export function Switch({ className, ...props }: Omit<ComponentProps<"input">, "type" | "role">) {
  return (
    <input className={classes("switch", className)} {...props} type="checkbox" role="switch" />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={classes("control-label", className)} {...props} />;
}

export function Fieldset(props: ComponentProps<"fieldset">) {
  return <fieldset {...props} />;
}

export function Progress({ className, ...props }: ComponentProps<"progress">) {
  return <progress className={classes("progress", className)} {...props} />;
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={classes("table", className)} {...props} />;
}

export function Details({ className, ...props }: ComponentProps<"details">) {
  return <details className={classes("disclosure", className)} {...props} />;
}

export function Summary(props: ComponentProps<"summary">) {
  return <summary {...props} />;
}

/** Browser navigation, including downloads and links outside the React router. */
export function A(props: ComponentProps<"a">) {
  return <a {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("card", className)} {...props} />;
}
