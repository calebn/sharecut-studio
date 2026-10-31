import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { AppliedEdit } from "./AppliedEdit";

export function useAppliedSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const rec = useDaw((s) =>
    selection?.kind === "applied"
      ? s.project?.applied_edits.records.find((r) => r.id === selection.id)
      : undefined,
  );
  if (selection?.kind !== "applied") return null;
  return [
    {
      id: "applied",
      rows: [
        {
          id: "applied",
          control: rec ? (
            <AppliedEdit key={rec.id} rec={rec} />
          ) : (
            <p className="ui-field-hint">Record not found</p>
          ),
        },
      ],
    },
  ];
}
