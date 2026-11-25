import { useCallback, useMemo, useState } from "react";
import {
  insertSegment,
  previewSegmentInsert,
  type SegmentInsertRequest,
} from "../../api";
import { selectionAnchor } from "../../commands/timelineReveal";
import { timelineEndSec } from "../../edit/pickupTarget";
import {
  segmentInsertedMessage,
  segmentInsertQueuedMessage,
} from "../../edit/segmentInsertMessages";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useSegmentLibrary } from "../../segments/useSegmentLibrary";
import { InsertSegmentCard } from "../../stages/edit/InsertSegmentCard";
import { useDawStore } from "../../state/dawStore";

const anchorElementOf = () =>
  selectionAnchor.get() ??
  document.querySelector<HTMLElement>(".playhead, .timeline-area");

function OpenInsertSegmentHost() {
  const setOpen = useDawStore((s) => s.setInsertSegmentOpen);
  const phone = useViewportClass() === "phone";
  const library = useSegmentLibrary();
  const [held] = useState(() => {
    const s = useDawStore.getState();
    return {
      projectPath: s.projectPath,
      playheadSec: s.playheadSec,
      timelineEnd: s.project ? timelineEndSec(s.project) : 0,
    };
  });
  const anchorElement = useMemo(() => anchorElementOf(), []);
  const anchorRef = useMemo(
    () => ({ current: anchorElement }),
    [anchorElement],
  );

  const { projectPath } = held;
  const loadPreview = useCallback(
    (request: SegmentInsertRequest, signal: AbortSignal) =>
      previewSegmentInsert(projectPath, request, signal),
    [projectPath],
  );
  const onInsert = async ({
    name,
    request,
  }: {
    name: string;
    request: SegmentInsertRequest;
  }) => {
    const outcome = await insertSegment(held.projectPath, request);
    const { announceStatus } = useDawStore.getState();
    if (outcome.queued) {
      announceStatus(segmentInsertQueuedMessage(name));
      return;
    }
    announceStatus(
      segmentInsertedMessage(name, outcome.applied),
      outcome.historyHead ? { undo: outcome.historyHead } : undefined,
    );
  };
  const common = {
    rows: library.rows,
    loadError: library.error,
    onRetryLoad: library.reload,
    playheadSec: held.playheadSec,
    timelineEnd: held.timelineEnd,
    loadPreview,
    onInsert,
    onClose: () => setOpen(false),
  };
  return phone || !anchorElement ? (
    <InsertSegmentCard {...common} form="bottom" open />
  ) : (
    <InsertSegmentCard {...common} anchorRef={anchorRef} />
  );
}

export function InsertSegmentHost() {
  const open = useDawStore((s) => s.chrome.insertSegmentOpen);
  return open ? <OpenInsertSegmentHost /> : null;
}
