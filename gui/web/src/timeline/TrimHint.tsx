import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { CoachHint } from "../system/CoachTip";
import { CoachTipBubble } from "../system/CoachTipBubble";
import { placeTrimHint, visibleLanes } from "./trimHintPlace";

const MARGIN_REM = 0.5;
const GAP_REM = 0.25;
const HANDLE_REM = 0.5;

type Spot = { left: number; top: number; maxWidth: number };

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Fixed to the screen, outside the clip: the ruler or a lane would hide a tip drawn inside the lanes. */
export function TrimHint({
  anchor,
  hint,
}: {
  anchor: RefObject<HTMLElement | null>;
  hint: CoachHint;
}) {
  const bubble = useRef<HTMLSpanElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const { onRelease } = hint;
  const place = useCallback(() => {
    const clip = anchor.current;
    const tip = bubble.current;
    if (!clip || !tip) return;
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const view = visibleLanes(clip, MARGIN_REM * rem);
    const maxWidth = Math.min(15 * rem, view.right - view.left);
    tip.style.maxInlineSize = `${maxWidth}px`;
    const size = tip.getBoundingClientRect();
    const at = placeTrimHint({
      clip: clip.getBoundingClientRect(),
      view,
      tip: { width: size.width, height: size.height },
      handle: HANDLE_REM * rem,
      gap: GAP_REM * rem,
    });
    if (at === null) {
      setSpot(null);
      onRelease?.();
      return;
    }
    setSpot((prev) =>
      prev &&
      prev.left === at.left &&
      prev.top === at.top &&
      prev.maxWidth === maxWidth
        ? prev
        : { ...at, maxWidth },
    );
  }, [anchor, onRelease]);
  const close = () => {
    anchor.current
      ?.querySelector<HTMLElement>(".clip-hit")
      ?.focus({ preventScroll: true });
    hint.onDismiss();
  };
  useLayoutEffect(place);
  useEffect(place, [place]);
  useEffect(() => {
    const scroller = anchor.current?.closest(".timeline-scroll");
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [anchor, place]);
  return createPortal(
    <span
      role="presentation"
      style={{ display: "contents" }}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onClick={stop}
      onDoubleClick={stop}
    >
      <CoachTipBubble
        ref={bubble}
        text={hint.text}
        placement="below"
        onClose={close}
        style={{
          position: "fixed",
          zIndex: "var(--z-timeline-popover)",
          right: "auto",
          bottom: "auto",
          left: spot?.left ?? 0,
          top: spot?.top ?? 0,
          maxInlineSize: spot?.maxWidth,
          visibility: spot ? undefined : "hidden",
        }}
      />
    </span>,
    anchor.current?.closest("main") ?? document.body,
  );
}
