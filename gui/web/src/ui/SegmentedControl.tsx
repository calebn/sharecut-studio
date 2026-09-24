import type { ReactNode } from "react";

type Props = {
  /** Accessible group name (omit when the segments are menu radios). */
  label?: string;
  /** Use `none` when the segments render as `menuitemradio` rows in a Menu. */
  role?: "group" | "none";
  className?: string;
  children: ReactNode;
};

/**
 * Track of mutually exclusive quiet ToggleButtons; the pressed segment is the
 * shared selected chip. Themed on panes, dark inside the transport, stacked
 * rows inside a Menu.
 */
export function SegmentedControl({
  label,
  role = "group",
  className,
  children,
}: Props) {
  return (
    <div
      className={className ? `ui-segmented ${className}` : "ui-segmented"}
      role={role}
      aria-label={role === "group" ? label : undefined}
    >
      {children}
    </div>
  );
}
