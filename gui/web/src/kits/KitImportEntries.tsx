import type { KitImportEntry } from "../api";
import { KIND_LABEL } from "../segments/format";
import { Pill } from "../ui";
import { formatTimeShort } from "../utils/time";
import { entryStatus, placement } from "./importMessages";

/** The segments of a waiting kit file, in the order the kit applies them. */
export function KitImportEntries({ entries }: { entries: KitImportEntry[] }) {
  const ordered = [...entries].sort((a, b) => a.position - b.position);
  return (
    <ol className="kit-import-entries" aria-label="Kit entries">
      {ordered.map((entry) => (
        <li key={entry.position} className="kit-import-entry">
          <span className="kit-import-entry-name">{entry.name}</span>
          <span className="kit-import-entry-meta">
            <Pill>{KIND_LABEL[entry.kind] ?? KIND_LABEL.other}</Pill>
            <span className="kit-import-entry-detail">
              {formatTimeShort(entry.duration_sec)}
            </span>
            <span className="kit-import-entry-detail">
              {placement(entry.at, formatTimeShort)}
            </span>
            <Pill tone={entry.outcome === "unchanged" ? "neutral" : "ok"}>
              {entryStatus(entry)}
            </Pill>
          </span>
          {entry.note ? (
            <span className="kit-import-entry-note">{entry.note}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
