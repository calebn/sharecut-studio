import { useDaw } from "../../state/useDaw";
import { rangeSection } from "./rangeSection";
import { useSelectionSections } from "./selectionSections";

export function SectionsBody({ withRange }: { withRange: boolean }) {
  const sections = useSelectionSections(useDaw((s) => s.selection));
  return (
    <div className="sys-inspector-rows">
      {sections
        ?.filter((section) => withRange || section !== rangeSection)
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
