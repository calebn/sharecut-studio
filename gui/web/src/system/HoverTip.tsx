import { type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "../ui/useAnchoredPanel";

type HoverTipProps = {
  id: string;
  anchor: HTMLElement;
  children: ReactNode;
};

export function HoverTip({ id, anchor, children }: HoverTipProps) {
  const panel = useRef<HTMLSpanElement>(null);
  useAnchoredPanel(
    panel,
    {
      reason: "A tip names the mark it hangs over",
      ref: { current: anchor },
      prefer: "above",
    },
    true,
  );
  return createPortal(
    <span ref={panel} id={id} role="tooltip" className="sys-tip">
      {children}
    </span>,
    document.body,
  );
}
