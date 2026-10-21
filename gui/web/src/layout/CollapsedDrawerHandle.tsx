import { type PointerEvent, useEffect, useRef } from "react";
import { executePointerCommand } from "../commands/pointer";
import { useResizeObserver } from "../ui/useResizeObserver";

/** An upward swipe this long (px) reopens, so a thumb never has to land a tap. */
export const REOPEN_SWIPE_PX = 8;

export interface CollapsedDrawerHandleViewProps {
  /** `byKeyboard` is true for Enter and Space, so focus can follow the drawer back. */
  onReopen: (byKeyboard: boolean) => void;
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Collapsing from the splitter unmounts the focused control; the handle
    // that replaces it takes the focus so a keyboard user is not sent to the
    // top of the page.
    const active = document.activeElement;
    if (!active || active === document.body) {
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, []);
  const railRef = useRef<HTMLDivElement>(null);
  // The handle reaches up over the timeline from the row's line, which puts
  // it on the timeline's horizontal scrollbar; lift it by the scrollbar's
  // thickness so a vertical swipe never grabs the scrollbar (#1966). A
  // scrollbar appearing resizes the content, not the scroller's own box, so
  // the content is observed too.
  const scroller = () =>
    document.querySelector<HTMLElement>(".timeline-scroll");
  useResizeObserver([scroller, () => scroller()?.firstElementChild], () => {
    const el = scroller();
    railRef.current?.style.setProperty(
      "--drawer-reopen-lift",
      `${el ? el.offsetHeight - el.clientHeight : 0}px`,
    );
  });
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    swipe.current = { pointerId: e.pointerId, startY: e.clientY };
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = swipe.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (s.startY - e.clientY >= REOPEN_SWIPE_PX) {
      swipe.current = null;
      onReopen(false);
    }
  };
  const end = () => {
    swipe.current = null;
  };
  return (
    <div className="drawer-reopen" ref={railRef}>
      <button
        ref={buttonRef}
        type="button"
        className="drawer-reopen-handle"
        aria-label="Show editor panels"
        title="Show editor panels · Tap or swipe up"
        onClick={(e) => onReopen(e.detail === 0)}
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
      onReopen={(byKeyboard) => {
        void executePointerCommand("layout.default").then(() => {
          if (!byKeyboard) return;
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>(".bottom-tabs-splitter")
              ?.focus({ preventScroll: true }),
          );
        });
      }}
    />
  );
}
