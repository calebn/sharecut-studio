import type { ReactNode } from "react";

/**
 * A button's idle and busy contents stacked in one grid cell, the one not
 * shown hidden from assistive tech, so the button is as wide as the wider of
 * the two and does not move or resize when it starts working.
 */
export function BusyLabel({
  idle,
  working,
  busy,
}: {
  idle: ReactNode;
  working: boolean;
  busy: ReactNode;
}) {
  return (
    <span className="sys-busy-label">
      <span aria-hidden={working ? "true" : undefined}>{idle}</span>
      <span aria-hidden={working ? undefined : "true"}>{busy}</span>
    </span>
  );
}
