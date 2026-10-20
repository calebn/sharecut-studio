import type { ReactNode } from "react";
import { Button } from "./Button";

type Props = {
  /** Element to render: `li` inside a list, `div` inside other blocks. */
  as?: "p" | "li" | "div";
  className?: string;
  /** `status` when the empty state replaces live content (announced). */
  role?: "status";
  /** The one control that fills the area or widens what it shows. */
  action?: { label: string; onClick: () => void };
  children: ReactNode;
};

/**
 * Quiet empty list or panel: muted text, no fill or border, so it never reads
 * as a disabled field next to real inputs. With an `action`, the area names
 * its way out instead of ending the person's path.
 */
export function EmptyState({
  as: Tag = "p",
  className,
  role,
  action,
  children,
}: Props) {
  const base = className ? `ui-empty-state ${className}` : "ui-empty-state";
  return (
    <Tag
      className={action ? `${base} ui-empty-state--action` : base}
      role={role}
    >
      {children}
      {action ? (
        <Button variant="link" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </Tag>
  );
}
