import { useCallback } from "react";
import { updatePendingEdit } from "../api";
import { useDaw } from "../state/useDaw";
import {
  PendingEditOverlayView,
  type PendingEditOverlayViewProps,
} from "./PendingEditOverlayView";

type PendingEditOverlayProps = Omit<
  PendingEditOverlayViewProps,
  "onCommitSpan"
>;

/** Live wiring: commits a handle drag through UpdatePendingEdit (snap on). */
export function PendingEditOverlay(props: PendingEditOverlayProps) {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const onCommitSpan = useCallback(
    (editId: string, sourceStart: number, sourceEnd: number) =>
      updatePendingEdit(projectPath, editId, sourceStart, sourceEnd, true),
    [projectPath],
  );
  return <PendingEditOverlayView {...props} onCommitSpan={onCommitSpan} />;
}
