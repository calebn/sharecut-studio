import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { executePointerCommand } from "../commands/pointer";
import { seekTransport } from "../commands/seek";
import { canSuggestStructuralOnProject } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { clientXToTimelineSec } from "../utils/timelinePointer";

/** Set on the lanes while Alt is held over them with a mouse or pen. */
export const SPLIT_ARMED_ATTR = "data-split-armed";

/** A finger has no Alt key; its Split arrives with the action bar. */
const isTouch = (e: { pointerType?: string }) => e.pointerType === "touch";

/**
 * Controls whose own click keeps its meaning under Alt: a chip, a seam, a
 * trim handle, a field. Only the clip body and the bare lane take the split.
 */
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
) {
  const pointer = useRef<{ clientX: number; inside: boolean }>({
    clientX: 0,
    inside: false,
  });

  /** The guide is up: moves without Alt do nothing until it is. */
  const shown = useRef(false);

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
      const sec =
        armed && pointer.current.inside && s.project
          ? secAt(pointer.current.clientX)
          : null;
      // The guide promises a cut; without permission there is nothing to show
      // (the click itself still explains why it did nothing).
      const allowed = canSuggestStructuralOnProject(
        s.projectPath,
        s.guestMode,
        s.shareCapabilities,
        s.project != null,
      );
      s.setSplitHoverSec(allowed ? sec : null);
      shown.current = allowed && sec != null;
      if (sec != null) lanes?.setAttribute(SPLIT_ARMED_ATTR, "");
      else lanes?.removeAttribute(SPLIT_ARMED_ATTR);
    },
    [lanesRef, secAt],
  );

  // Always the latest closure, so the window listeners never go stale.
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      showRef.current(e.type === "keydown");
    };
    const release = () => showRef.current(false);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
      // The hover belongs to these lanes; it goes when they do.
      useDawStore.getState().setSplitHoverSec(null);
    };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    pointer.current = { clientX: e.clientX, inside: true };
    const armed = e.altKey && !isTouch(e);
    if (armed || shown.current) showRef.current(armed);
  }, []);

  const onPointerLeave = useCallback(() => {
    pointer.current.inside = false;
    showRef.current(false);
  }, []);

  /**
   * Capture-phase click on the lanes. True when the click was an Alt-click and
   * is spent: it neither selects nor seeks nor ends a range gesture.
   */
  const onClickCapture = useCallback(
    (e: ReactMouseEvent<HTMLElement>): boolean => {
      const native = e.nativeEvent as { pointerType?: string };
      if (!e.altKey || isTouch(native)) return false;
      if (e.target instanceof Element && e.target.closest(OWN_CLICK))
        return false;
      const sec = secAt(e.clientX);
      if (sec == null) return false;
      e.preventDefault();
      e.stopPropagation();
      void seekTransport(sec);
      void executePointerCommand("edit.bladeCut", { atTime: sec }).then(
        (result) => {
          if (result.status === "disabled") {
            useDawStore
              .getState()
              .announceStatus(result.reason, { tone: "error" });
          }
        },
      );
      return true;
    },
    [secAt],
  );

  return { onPointerMove, onPointerLeave, onClickCapture };
}
