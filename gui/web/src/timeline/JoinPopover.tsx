import { type RefObject, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { setClipJoin } from "../api";
import { JOIN_AUDITION_PAD_SEC, joinGlyph } from "../edit/joinRender";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { canApplyPass12 } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { ClipRow } from "../types/project";
import {
  InspectorSeekFooter,
  useDialogModal,
  useOutsidePointerDown,
} from "../ui";
import { JoinPopoverView } from "./JoinPopoverView";
import { placeJoinPopover } from "./joinPopoverPlacement";

export interface JoinPopoverProps {
  id: string;
  left: ClipRow;
  right: ClipRow;
  seamSec: number;
  trackFadeMaxMs: number | null;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
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
}: JoinPopoverProps) {
  const { projectPath, guestMode, shareCapabilities } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const { busy, error, run } = useProjectMutation();
  const panelRef = useRef<HTMLDivElement>(null);
  // GOVERNANCE: Escape via useDialogModal (allowlisted); non-modal, focus returns to this popover's badge.
  useDialogModal({
    open: true,
    onClose,
    panelRef,
    mode: "sheet",
    returnFocusRef: anchorRef,
  });

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) {
        return;
      }
      const rootPx =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      const { left: x, top: y } = placeJoinPopover(
        anchor.getBoundingClientRect(),
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        0.5 * rootPx,
      );
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, seamSec]);

  useOutsidePointerDown([panelRef, anchorRef], onClose);

  const mode = joinGlyph(right);
  return createPortal(
    <JoinPopoverView
      id={id}
      panelRef={panelRef}
      left={left}
      right={right}
      seamSec={seamSec}
      trackFadeMaxMs={trackFadeMaxMs}
      editable={editable}
      busy={busy}
      error={error}
      onClose={onClose}
      onModeChange={(next) =>
        void run(() => setClipJoin(projectPath, left.id, right.id, next, null))
      }
      onLengthCommit={(ms) =>
        void run(() => setClipJoin(projectPath, left.id, right.id, mode, ms))
      }
      footer={
        <InspectorSeekFooter
          seekSec={seamSec}
          playStart={seamSec}
          playEnd={seamSec}
          padSec={JOIN_AUDITION_PAD_SEC}
          seekLabel="Seek join"
          playLabel="Audition join"
          actionVariant="default"
        />
      }
    />,
    document.body,
  );
}
