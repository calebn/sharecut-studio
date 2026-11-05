import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { executePointerCommand } from "../commands/pointer";
import { announceRefusal } from "../commands/refusal";
import { seekTransport } from "../commands/seek";
import { MOVE_THRESHOLD_PX } from "../hooks/gestureConstants";
import { canSuggestStructuralOnProject } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { ApiError } from "../utils/apiError";
import { clientXToTimelineSec } from "../utils/timelinePointer";
import { useStableCallback } from "../utils/useStableCallback";

const SPLIT_ARMED_ATTR = "data-split-armed";

/** A finger has no Alt key; its Split arrives with the action bar. */
export const isSplitModifier = (e: { altKey: boolean; pointerType?: string }) =>
  e.altKey && e.pointerType !== "touch";

const NO_CLIP_CODE = "no_clip_at_time";

/** Why an Alt-click split failed, in plain words. */
function splitFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === NO_CLIP_CODE)
    return "There is no clip at that time to split";
  return error instanceof Error && error.message
    ? error.message
    : "Could not split there";
}

/** Controls whose own click keeps its meaning under Alt. */
const OWN_CLICK = "button:not(.clip-hit), a, input, select, [role='slider']";

/**
 * Alt-click Split at the pointer. Holding Alt over the lanes shows a guide at
 * the pointer's time (`splitHoverSec`) on each target lane; Alt+click runs
 * `edit.bladeCut` there, the same command Mod+K runs at the playhead. A plain
 * click never splits.
 *
 * Alt is read from the pointer events themselves (every one carries the live
 * modifier), and from Alt key events so the guide follows a press made while the
 * pointer rests. A key-up can be lost to another window (Alt-Tab, the OS menu
 * bar), so blur and a hidden page clear it, and so does the pointer leaving.
 */
export function useSplitAtPointer(
  lanesRef: RefObject<HTMLElement | null>,
  zoomPxPerSec: number,
  canvasSec: number,
  headerOffsetPx?: number,
) {
  const pointer = useRef<{ clientX: number; inside: boolean }>({
    clientX: 0,
    inside: false,
  });

  const shown = useRef(false);
  /** Where the last Alt press went down; a click spends it, a plain press clears it. */
  const altDown = useRef<{ x: number; y: number } | null>(null);

  const secAt = useCallback(
    (clientX: number): number | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      return clientXToTimelineSec(
        clientX,
        lanes,
        useDawStore.getState().scrollLeft,
        zoomPxPerSec,
        canvasSec,
      );
    },
    [lanesRef, zoomPxPerSec, canvasSec],
  );

  const show = useCallback(
    (armed: boolean) => {
      const lanes = lanesRef.current;
      const s = useDawStore.getState();
      const allowed = canSuggestStructuralOnProject(
        s.projectPath,
        s.guestMode,
        s.shareCapabilities,
        s.project != null,
      );
      const sec =
        armed && allowed && pointer.current.inside && s.project
          ? secAt(pointer.current.clientX)
          : null;
      s.setSplitHoverSec(sec);
      shown.current = sec != null;
      if (sec != null) lanes?.setAttribute(SPLIT_ARMED_ATTR, "");
      else lanes?.removeAttribute(SPLIT_ARMED_ATTR);
    },
    [lanesRef, secAt],
  );

  // The window listeners are bound once.
  const showCurrent = useStableCallback(show);

  useLayoutEffect(() => {
    if (shown.current) show(true);
  }, [show, headerOffsetPx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      showCurrent(e.type === "keydown");
    };
    const release = () => showCurrent(false);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    const scroller = lanesRef.current?.closest(".timeline-scroll");
    const onScroll = () => {
      if (shown.current) showCurrent(true);
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
      useDawStore.getState().setSplitHoverSec(null);
    };
  }, [lanesRef, showCurrent]);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      pointer.current = { clientX: e.clientX, inside: true };
      const armed = isSplitModifier(e);
      if (armed || shown.current) showCurrent(armed);
    },
    [showCurrent],
  );

  const onPointerLeave = useCallback(() => {
    pointer.current.inside = false;
    showCurrent(false);
  }, [showCurrent]);

  const onPointerDownCapture = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      altDown.current = isSplitModifier(e)
        ? { x: e.clientX, y: e.clientY }
        : null;
    },
    [],
  );

  /** True when the click was an Alt-click and is spent: it neither selects, seeks nor ends a range gesture. */
  const onClickCapture = useCallback(
    (e: ReactMouseEvent<HTMLElement>): boolean => {
      const { pointerType } = e.nativeEvent as { pointerType?: string };
      if (!isSplitModifier({ altKey: e.altKey, pointerType })) return false;
      if (e.target instanceof Element && e.target.closest(OWN_CLICK))
        return false;
      const down = altDown.current;
      altDown.current = null;
      // A drag ends in a click on the common ancestor; only a press that stayed put is a split.
      if (
        !down ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOVE_THRESHOLD_PX
      )
        return false;
      const sec = secAt(e.clientX);
      if (sec == null) return false;
      e.preventDefault();
      e.stopPropagation();
      void seekTransport(sec);
      void executePointerCommand("edit.bladeCut", { atTime: sec }).then(
        announceRefusal,
        (error: unknown) =>
          useDawStore
            .getState()
            .announceStatus(splitFailure(error), { tone: "error" }),
      );
      return true;
    },
    [secAt],
  );

  return {
    onPointerDownCapture,
    onPointerMove,
    onPointerLeave,
    onClickCapture,
  };
}
