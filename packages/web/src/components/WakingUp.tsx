// SPDX-License-Identifier: MIT
/**
 * What the website shows while a sleeping server starts: a page of its own before anything
 * has loaded, or a strip above the page when the server fell asleep during a visit. The
 * bar follows how long the last start took; it never reaches the end before the server
 * answers.
 */
import { useEffect, useState } from "react";
import type { ServerState } from "../lib/wake.ts";

/** How full the bar may get before the server is up. */
const MAX_FRACTION = 0.95;

export function WakingUp({ server, compact = false }: { server: ServerState; compact?: boolean }) {
  const now = useNow(server.state === "starting");
  if (server.state === "awake") return null;
  const className = compact ? "waking waking-compact" : "waking";
  if (server.state === "paused") {
    return (
      <div className={className} role="status">
        <p className="waking-title">Quaso is paused for maintenance</p>
        <p className="waking-text">This page continues on its own when Quaso is back.</p>
      </div>
    );
  }
  const elapsedMs = server.elapsedMs + Math.max(0, now - server.receivedAt);
  const seconds = Math.floor(elapsedMs / 1000);
  const expectedSeconds = Math.round(server.expectedMs / 1000);
  const percent = Math.round(Math.min(elapsedMs / server.expectedMs, MAX_FRACTION) * 100);
  const slow = elapsedMs > server.expectedMs * 1.5;
  return (
    <div className={className} role="status">
      <p className="waking-title">Waking up Quaso…</p>
      <p className="waking-text">
        {slow
          ? "This start is taking longer than usual. This page continues on its own when Quaso is ready."
          : `Quaso sleeps when nobody uses it, and takes about ${expectedSeconds} seconds to start. This page continues on its own.`}
      </p>
      <div
        className="bar bar-medium"
        role="progressbar"
        aria-label="Starting Quaso"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className="bar-part bar-blue waking-progress" style={{ width: `${percent}%` }} />
      </div>
      <p className="waking-elapsed">{seconds} s</p>
    </div>
  );
}

/** The time, every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
