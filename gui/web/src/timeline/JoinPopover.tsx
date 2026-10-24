import { type RefObject, useCallback } from "react";
import { JOIN_AUDITION_PAD_SEC, joinSeamLabel } from "../edit/joinRender";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";
import { Dialog, InspectorSeekFooter } from "../ui";
import { joinKind } from "../utils/editMarkerRegistry";
import { JoinPopoverView } from "./JoinPopoverView";
import { ROUTER_TRACE, routerTrace } from "./routerTrace";
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
  gripRef?: RefObject<HTMLElement | null>;
}

/** The join editor: an anchored `Dialog`, so the seam it edits stays in view. */
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
  gripRef,
}: JoinPopoverProps) {
  // Dismissing mid-request would unmount the popover and drop a failure
  // silently, so Escape, Close, an outside click and opening another join
  // glyph (EditMarkerLayer.tsx) all wait for SetClipJoin to settle.
  const dismiss = useCallback(() => {
    if (ROUTER_TRACE) {
      routerTrace("popover-dismiss", { stack: new Error().stack });
    }
    if (!useDawStore.getState().joinMutationInFlight) {
      edit.cancel();
      onClose();
    }
  }, [onClose, edit]);

  return (
    <Dialog
      open
      onClose={dismiss}
      title={joinSeamLabel(joinKind(right), seamSec)}
      panelId={id}
      anchor={{
        reason:
          "the join under the timeline stays in view while its mode and fades are edited, so a sheet would cover the seam being heard",
        ref: anchorRef,
        avoidRef: railRef,
        clearRef: gripRef,
        moves: `${seamSec}|${right.join_in_mode}|${edit.value}`,
      }}
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
    >
      <JoinPopoverView
        left={left}
        right={right}
        trackFadeMaxMs={trackFadeMaxMs}
        editable={edit.editable}
        busy={edit.busy}
        error={edit.error}
        onModeChange={edit.changeMode}
        lengthControl={{ value: edit.value, inputProps: edit.rangeProps }}
      />
    </Dialog>
  );
}
