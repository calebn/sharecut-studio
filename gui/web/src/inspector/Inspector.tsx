import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDaw } from "../state/useDaw";
import { selectUnmappedPending } from "../utils/edits";
import { renderSelectionBody } from "./selectionSurface";
import { EmptyInspector } from "./views/EmptyInspector";

export function Inspector({
  placement = "rail",
}: {
  placement?: "rail" | "sheet";
}) {
  const { project, projectEpoch, selection, setSelection, setPlayheadSec } =
    useDaw((s) => ({
      project: s.project,
      projectEpoch: s.projectEpoch,
      selection: s.selection,
      setSelection: s.setSelection,
      setPlayheadSec: s.setPlayheadSec,
    }));

  if (!project) {
    return (
      <aside
        className="inspector"
        {...presenceAnchorProps(presenceAnchor("inspector"))}
      >
        <p>Loading episode…</p>
      </aside>
    );
  }

  const unmappable = selectUnmappedPending(project.pending_edits);

  if (!selection) {
    return (
      <EmptyInspector
        unmappable={unmappable}
        onSelectPending={(e) =>
          setSelection({
            kind: "pending",
            id: e.id,
            trackId: e.track_id,
          })
        }
      />
    );
  }

  return renderSelectionBody(selection, {
    project,
    projectEpoch,
    setPlayheadSec,
    placement,
  });
}
