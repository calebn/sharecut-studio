import type { SegmentRow } from "../api";
import { KIND_LABEL, segmentLengthSec } from "../segments/format";
import { SystemIcon } from "../system/SystemIcon";
import { Button, Pill, SegmentedControl, ToggleButton } from "../ui";
import { formatTimeShort } from "../utils/time";
import type { DraftEntry, KitAt } from "./kitDraft";
import { GONE_NOTE, startOrderNote } from "./kitEditorCopy";

type Props = {
  entry: DraftEntry;
  position: number;
  total: number;
  /** Null when the library no longer lists a readable segment with this id. */
  segment: SegmentRow | null;
  /** The name of the earlier Start entry this one will land ahead of, or null. */
  aheadOf: string | null;
  disabled: boolean;
  onAt: (at: KitAt) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
};

export function KitEntryRow({
  entry,
  position,
  total,
  segment,
  aheadOf,
  disabled,
  onAt,
  onMove,
  onRemove,
}: Props) {
  const name = segment?.name ?? entry.segmentId;
  return (
    <li className="kit-entry" data-kit-entry={entry.uid}>
      <div className="kit-entry-main">
        <span className="kit-entry-pos" aria-hidden="true">
          {position}
        </span>
        <span className="kit-name">{name}</span>
        {segment ? (
          <span className="kit-meta">
            <Pill>{KIND_LABEL[segment.kind] ?? KIND_LABEL.other}</Pill>
            <span className="kit-count">
              {formatTimeShort(segmentLengthSec(segment))}
            </span>
          </span>
        ) : null}
      </div>
      {segment ? (
        <SegmentedControl
          role="radiogroup"
          label={`Where ${name} goes`}
          className="kit-entry-at"
        >
          {(["start", "end"] as const).map((at) => (
            <ToggleButton
              key={at}
              role="radio"
              aria-checked={entry.at === at}
              pressed={entry.at === at}
              disabledReason={disabled ? "Saving the kit." : undefined}
              onClick={() => onAt(at)}
            >
              {at === "start" ? "Start" : "End"}
            </ToggleButton>
          ))}
        </SegmentedControl>
      ) : (
        <p className="kit-problem" role="note">
          {GONE_NOTE}
        </p>
      )}
      <div className="kit-entry-actions">
        <Button
          className="kit-icon-button"
          data-move="up"
          aria-label={`Move ${name} up`}
          disabledReason={
            disabled
              ? "Saving the kit."
              : position === 1
                ? "Already first"
                : undefined
          }
          onClick={() => onMove(-1)}
        >
          <SystemIcon name="chevron-up" size={16} />
        </Button>
        <Button
          className="kit-icon-button"
          data-move="down"
          aria-label={`Move ${name} down`}
          disabledReason={
            disabled
              ? "Saving the kit."
              : position === total
                ? "Already last"
                : undefined
          }
          onClick={() => onMove(1)}
        >
          <SystemIcon name="chevron-down" size={16} />
        </Button>
        <Button
          className="kit-icon-button"
          data-remove
          aria-label={`Remove ${name} from the kit`}
          disabledReason={disabled ? "Saving the kit." : undefined}
          onClick={onRemove}
        >
          <SystemIcon name="trash-2" size={16} />
        </Button>
      </div>
      {aheadOf ? (
        <p className="kit-problem kit-entry-warning" role="note">
          {startOrderNote(name, aheadOf)}
        </p>
      ) : null}
    </li>
  );
}
