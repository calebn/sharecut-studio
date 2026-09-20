import type { ReactNode } from "react";

/** Horizontal nudge / form control row (`.nudge-fields`). */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="nudge-fields">{children}</div>;
}
