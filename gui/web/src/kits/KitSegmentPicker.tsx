import type { SegmentListRow, SegmentRow } from "../api";
import { KIND_LABEL, segmentLengthSec, versionTag } from "../segments/format";
import { SystemIcon } from "../system/SystemIcon";
import { Button, Pill } from "../ui";
import { formatTimeShort } from "../utils/time";
import { MAX_ENTRIES } from "./kitDraft";
import { healthySegments, unreadableNote } from "./kitEditorCopy";

export const PICKER_LABEL = "Segments you can add";
export const PICKER_EMPTY =
  "Save a segment from an episode first, then build a kit from it.";
export const PICKER_LOADING = "Loading your segments…";
export const FULL_REASON = `A kit holds up to ${MAX_ENTRIES} segments.`;

type Props = {
  rows: readonly SegmentListRow[] | null;
  /** How many times each segment is already in the kit. */
  used: (segmentId: string) => number;
  full: boolean;
  disabled: boolean;
  onAdd: (segment: SegmentRow) => void;
};

/** Library segments to add; a damaged one cannot be saved into a kit usefully, so it is left out. */
export function KitSegmentPicker({ rows, used, full, disabled, onAdd }: Props) {
  if (rows === null)
    return <p className="kit-library-empty">{PICKER_LOADING}</p>;
  const usable = healthySegments(rows);
  const hidden = rows.length - usable.length;
  return (
    <>
      {usable.length === 0 ? (
        <p className="kit-library-empty">{PICKER_EMPTY}</p>
      ) : (
        <ul className="kit-list" aria-label={PICKER_LABEL}>
          {usable.map((segment) => {
            const count = used(segment.id);
            return (
              <li
                key={segment.id}
                className="kit-row kit-pick"
                data-kit-pick={segment.id}
              >
                <div className="kit-main">
                  <span className="kit-name">{segment.name}</span>
                  <span className="kit-tag">{versionTag(segment)}</span>
                  <span className="kit-meta">
                    <Pill>{KIND_LABEL[segment.kind] ?? KIND_LABEL.other}</Pill>
                    <span className="kit-count">
                      {formatTimeShort(segmentLengthSec(segment))}
                    </span>
                    {count > 0 ? (
                      <span className="kit-count">In kit ({count})</span>
                    ) : null}
                  </span>
                </div>
                <Button
                  className="kit-pick-add"
                  aria-label={`Add ${segment.name}`}
                  disabledReason={
                    disabled
                      ? "Saving the kit."
                      : full
                        ? FULL_REASON
                        : undefined
                  }
                  onClick={() => onAdd(segment)}
                >
                  <SystemIcon name="plus" size={16} />
                  Add
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 ? (
        <p className="kit-problem">{unreadableNote(hidden)}</p>
      ) : null}
    </>
  );
}
