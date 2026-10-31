import { useDaw } from "../../state/useDaw";
import { useSelectionSections } from "./selectionSections";

/** The same content as plain rows, for a surface that does not mount the sheet. */
export function SectionsBody() {
  const sections = useSelectionSections(useDaw((s) => s.selection));
  return (
    <div className="sys-inspector-rows">
      {sections?.flatMap((section) =>
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
