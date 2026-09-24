import type { ReactNode } from "react";

type Props = {
  /** Element to render: `li` inside a list, `div` inside other blocks. */
  as?: "p" | "li" | "div";
  className?: string;
  /** `status` when the empty state replaces live content (announced). */
  role?: "status";
  children: ReactNode;
};

/**
 * Quiet empty list or panel: muted text, no fill or border, so it never reads
 * as a disabled field next to real inputs.
 */
export function EmptyState({
  as: Tag = "p",
  className,
  role,
  children,
}: Props) {
  return (
    <Tag
      className={className ? `ui-empty-state ${className}` : "ui-empty-state"}
      role={role}
    >
      {children}
    </Tag>
  );
}
