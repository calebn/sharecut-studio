import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { JOIN_AUDITION_PAD_SEC } from "../edit/joinRender";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";
import {
  InspectorSeekFooter,
  useDialogModal,
  useOutsidePointerDown,
  useResizeObserver,
} from "../ui";
import { useStableCallback } from "../utils/useStableCallback";
import { JoinPopoverView } from "./JoinPopoverView";
import { placeJoinPopover } from "./joinPopoverPlacement";
import type { JoinEdit } from "./useJoinEdit";

export interface JoinPopoverProps {
  id: string;
  left: ClipRow;
  right: ClipRow;
  seamSec: number;
  trackFadeMaxMs: number | null;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  edit: JoinEdit;
  railRef: RefObject<HTMLElement | null>;
}

/** Live adapter: portals `JoinPopoverView` to `<body>`, fixed at its badge. */
export function JoinPopover({
  id,
  left,
  right,
  seamSec,
  trackFadeMaxMs,
  anchorRef,
  onClose,
  edit,
  railRef,
}: JoinPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Dismissing mid-request would unmount the popover and drop a failure
  // silently, so Escape, Close, an outside click and opening another join
  // badge (JoinBadge.tsx) all wait for SetClipJoin to settle.
  const dismiss = useCallback(() => {
    if (!useDawStore.getState().joinMutationInFlight) {
      edit.cancel();
      onClose();
    }
  }, [onClose, edit]);
  // GOVERNANCE: Escape via useDialogModal (allowlisted); non-modal, focus returns to this popover's badge.
  useDialogModal({
    open: true,
    onClose: dismiss,
    panelRef,
    mode: "sheet",
    returnFocusRef: anchorRef,
  });

  const place = useStableCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) {
      return;
    }
    const rootPx =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
      16;
    const { left: x, top: y } = placeJoinPopover(
      anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight },
      {
        width: window.innerWidth,
        height:
          railRef.current?.getBoundingClientRect().top ?? window.innerHeight,
      },
      0.5 * rootPx,
    );
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });
  useLayoutEffect(() => {
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place, anchorRef, seamSec, railRef, right.join_in_mode]);
  // A mode change adds or drops the Length row (an error adds a line), so
  // re-place whenever the panel resizes, not only on window resize/scroll.
  // The observer's first notification (async, after layout) repeats the
  // layout effect's mount-time place(); place() only rewrites left/top, so
  // the repeat is a no-op. If placement ever animates, skip that first call.
  useResizeObserver(panelRef, place);
  useResizeObserver(railRef, place);

  useOutsidePointerDown([panelRef, anchorRef, railRef], dismiss);

  return createPortal(
    <JoinPopoverView
      id={id}
      panelRef={panelRef}
      left={left}
      right={right}
      seamSec={seamSec}
      trackFadeMaxMs={trackFadeMaxMs}
      editable={edit.editable}
      busy={edit.busy}
      error={edit.error}
      onClose={dismiss}
      onModeChange={edit.changeMode}
      lengthControl={{ value: edit.value, inputProps: edit.rangeProps }}
      footer={
        <InspectorSeekFooter
          seekSec={seamSec}
          playStart={seamSec}
          playEnd={seamSec}
          padSec={JOIN_AUDITION_PAD_SEC}
          seekLabel="Seek join"
          playLabel="Audition join"
        />
      }
    />,
    document.body,
  );
}
