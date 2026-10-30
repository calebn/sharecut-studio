import { selectionSpan } from "../../edit/editSelection";
import { replaceableSpan } from "../../edit/pickupTarget";
import type { RecordSnapshot, SessionTarget } from "../../record";
import { useDawStore } from "../../state/dawStore";
import { SessionTargetChip } from "../../system/SessionTargetChip";
import { BUSY_REASON } from "../../ui/disabledReason";
import {
  lastClipEndSec,
  targetLocked,
  targetViewOf,
  wireTargetOf,
} from "./recordStageModel";

type RecordTargetChipProps = {
  snapshot: RecordSnapshot;
  busy: boolean;
  onSetTarget: (target: SessionTarget) => void;
};

/**
 * The host header's Session target chip. A leaf, so the playhead and the Edit
 * selection it reads re-render only the chip, not the Record stage.
 */
export function RecordTargetChip({
  snapshot,
  busy,
  onSetTarget,
}: RecordTargetChipProps) {
  const project = useDawStore((s) => s.project);
  // Whole seconds, so playback does not re-render the chip on every frame.
  const playheadSec = useDawStore((s) => Math.floor(s.playheadSec));
  const editSelection = useDawStore((s) => s.selection);
  const endSec = lastClipEndSec(project);
  const selected =
    project && editSelection ? selectionSpan(editSelection, project) : null;
  const replaceable = replaceableSpan(selected, project);
  return (
    <SessionTargetChip
      target={targetViewOf(snapshot.target, endSec)}
      locked={targetLocked(snapshot)}
      endAfterSec={endSec}
      disabledReason={busy ? BUSY_REASON : undefined}
      playheadSec={endSec === undefined ? undefined : playheadSec}
      selection={
        replaceable
          ? { fromSec: replaceable.start, toSec: replaceable.end }
          : undefined
      }
      onChange={(next) =>
        onSetTarget(wireTargetOf(next, replaceable?.trackIds ?? []))
      }
    />
  );
}
