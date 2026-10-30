import { useDaw } from "../../state/useDaw";
import { useEnvelopePointSections } from "./envelopePointSections";

/** The same content in the peek strip's drawer, until the strip goes. */
export function EnvelopePointBody() {
  const sections = useEnvelopePointSections(useDaw((s) => s.selection));
  return (
    <div className="sys-inspector-rows">
      {sections?.flatMap((section) =>
        section.rows.map((row) => (
          <div
            key={row.id}
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
