import { type PointerEvent, useRef } from "react";
import { runPointerCommand } from "../commands/pointer";

/** An upward swipe this long (px) reopens, so a thumb never has to land a tap. */
export const REOPEN_SWIPE_PX = 8;

export interface CollapsedDrawerHandleViewProps {
  onReopen: () => void;
}

/**
 * Grab handle on the bottom edge of the timeline layout, where the drawer's
 * splitter sat before it collapsed. Tap, Enter, Space or a swipe up brings the
 * drawer back at its last height.
 */
export function CollapsedDrawerHandleView({
  onReopen,
}: CollapsedDrawerHandleViewProps) {
  const swipe = useRef<{ pointerId: number; startY: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    swipe.current = { pointerId: e.pointerId, startY: e.clientY };
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = swipe.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (s.startY - e.clientY >= REOPEN_SWIPE_PX) {
      swipe.current = null;
      onReopen();
    }
  };
  const end = () => {
    swipe.current = null;
  };
  return (
    <div className="drawer-reopen">
      <button
        type="button"
        className="drawer-reopen-handle"
        aria-label="Show editor panels"
        title="Show editor panels · Tap or swipe up"
        onClick={onReopen}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span className="bottom-tabs-splitter-grip" aria-hidden />
      </button>
    </div>
  );
}

/** Live adapter: the same `layout.default` command as **Restore layout**. */
export function CollapsedDrawerHandle() {
  return (
    <CollapsedDrawerHandleView
      onReopen={() => runPointerCommand("layout.default")}
    />
  );
}
