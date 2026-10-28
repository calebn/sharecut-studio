import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDaw } from "../state/useDaw";
import { renderSelectionBody } from "./selectionSurface";

export function Inspector({
  placement = "rail",
}: {
  placement?: "rail" | "sheet";
}) {
  const { project, projectEpoch, selection } = useDaw((s) => ({
    project: s.project,
    projectEpoch: s.projectEpoch,
    selection: s.selection,
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

  if (!selection) return null;

  return renderSelectionBody(selection, {
    project,
    projectEpoch,
    placement,
  });
}
