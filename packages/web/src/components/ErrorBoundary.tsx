// SPDX-License-Identifier: MIT
import { Button } from "./Button.tsx";
import { H1 } from "./Typography.tsx";
/** Catches a page's rendering errors, so one broken page doesn't blank the whole website. */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: unknown;
}

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidUpdate(previous: { resetKey?: string }): void {
    // Going to another page tries again.
    if (previous.resetKey !== this.props.resetKey && this.state.error !== undefined) {
      this.setState({ error: undefined });
    }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      "The page failed to render",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      info.componentStack,
    );
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="page narrow" role="alert">
        <H1>Something went wrong</H1>
        <p>This page failed to show. Reloading usually helps.</p>
        <p>
          <Button variant="primary" type="button" onClick={() => location.reload()}>
            Reload the page
          </Button>
        </p>
      </div>
    );
  }
}
