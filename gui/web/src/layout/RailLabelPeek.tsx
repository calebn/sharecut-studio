import { useLayoutEffect, useRef, useState } from "react";
import type { Peek } from "./useRailLabelPeek";

const EDGE_PX = 8;

/** The transient label; it lets presses through. The control's own name already reaches screen readers. */
export function RailLabelPeek({ peek }: { peek: Peek | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!peek || !el) {
      setLeft(null);
      return;
    }
    const half = el.offsetWidth / 2;
    const max = window.innerWidth - EDGE_PX - half;
    setLeft(Math.max(EDGE_PX + half, Math.min(peek.centerX, max)));
  }, [peek]);
  if (!peek) return null;
  return (
    <div
      ref={ref}
      className="editing-tool-rail-peek"
      aria-hidden="true"
      style={{ left: left ?? peek.centerX, bottom: peek.bottom }}
    >
      {peek.text}
    </div>
  );
}
