import type { ReactNode } from "react";

type Props = {
  className?: string;
  /** `status` when the empty state replaces live content (announced). */
  role?: "status";
  children: ReactNode;
};

/**
 * Quiet empty list or panel: muted text, no fill or border, so it never reads
 * as a disabled field next to real inputs.
 */
export function EmptyState({ className, role, children }: Props) {
  return (
    <p
      className={className ? `ui-empty-state ${className}` : "ui-empty-state"}
      role={role}
    >
      {children}
    </p>
  );
}
