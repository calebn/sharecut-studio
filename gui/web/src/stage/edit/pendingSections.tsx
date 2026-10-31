import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { PendingEditBody } from "./PendingEditBody";

const only = (control: React.ReactNode): InspectorSection[] => [
  { id: "pending", rows: [{ id: "pending", control }] },
];

export function usePendingSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const project = useDaw((s) =>
    selection?.kind === "pending" || selection?.kind === "comment"
      ? s.project
      : null,
  );
  if (selection?.kind === "pending") {
    const edit = project?.pending_edits.find((e) => e.id === selection.id);
    return only(
      edit ? (
        <PendingEditBody edit={edit} />
      ) : (
        <p className="ui-field-hint">Edit not found</p>
      ),
    );
  }
  if (selection?.kind !== "comment") return null;
  const linkedId = project?.comments?.find(
    (c) => c.id === selection.id,
  )?.edit_decision_id;
  const linked = linkedId
    ? project?.pending_edits.find((e) => e.id === linkedId)
    : undefined;
  return linked ? only(<PendingEditBody edit={linked} />) : null;
}
