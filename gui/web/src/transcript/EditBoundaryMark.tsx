import { rollClipJoin, trimClipEdge } from "../api";
import { rollNeighborBounds } from "../edit/clipEdgePreview";
import { useDawStore } from "../state/dawStore";
import type { ClipRow, EditBoundaryView } from "../types/project";
import { EditBoundaryMarkView } from "./EditBoundaryMarkView";

type Props = {
  boundary: EditBoundaryView;
  leftClip: ClipRow | null;
  rightClip: ClipRow | null;
};

/**
 * Live wiring: roll/trim commits, and roll clamps read from the store when a
 * drag starts (not on every project update).
 */
export function EditBoundaryMark({ boundary, leftClip, rightClip }: Props) {
  const projectPath = useDawStore((s) => s.projectPath);
  return (
    <EditBoundaryMarkView
      boundary={boundary}
      leftClip={leftClip}
      rightClip={rightClip}
      getRollBounds={() =>
        rollNeighborBounds(useDawStore.getState().project, leftClip, rightClip)
      }
      onRoll={(l, r, d) => rollClipJoin(projectPath, l, r, d)}
      onTrim={(id, edge, sec) => trimClipEdge(projectPath, id, edge, sec)}
    />
  );
}
