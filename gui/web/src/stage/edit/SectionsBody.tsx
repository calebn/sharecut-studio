import { useDaw } from "../../state/useDaw";
import { useSelectionSections } from "./selectionSections";

export function SectionsBody({
  withRange,
  barShown = false,
}: {
  withRange: boolean;
  barShown?: boolean;
}) {
  const sections = useSelectionSections(
    useDaw((s) => s.selection),
    false,
    barShown,
  );
  return (
    <div className="sys-inspector-rows">
      {sections
        // SelectionSheetBody renders the related commands under this body itself.
        ?.filter(
          (section) =>
            section.id !== "related" && (withRange || section.id !== "range"),
        )
        .flatMap((section) =>
          section.rows.map((row) => (
            <div
              key={`${section.id}:${row.id}`}
              className="sys-inspector-row"
              data-unlabelled={row.label ? undefined : ""}
            >
              {row.label ? (
                <span className="sys-inspector-label">{row.label}</span>
              ) : null}
              <div className="sys-inspector-slot">{row.control}</div>
            </div>
          )),
        )}
    </div>
  );
}
