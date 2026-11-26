import { useId } from "react";
import type { SegmentRow } from "../api";
import { KIND_LABEL, segmentLengthSec } from "../segments/format";
import { SystemIcon } from "../system/SystemIcon";
import { Button, Pill, SegmentedControl, ToggleButton } from "../ui";
import { formatTimeShort } from "../utils/time";
import type { DraftEntry, KitAt } from "./kitDraft";
import { GONE_NAME, GONE_NOTE, startOrderNote } from "./kitEditorCopy";

type Props = {
  entry: DraftEntry;
  position: number;
  total: number;
  /** Null when the library no longer lists a readable segment with this id. */
  segment: SegmentRow | null;
  /** The name of the earlier Start entry this one will land ahead of, or null. */
  aheadOf: string | null;
  disabled: boolean;
  /** Id of the sheet's "Saving the kit" line, which says why a disabled control is off. */
  busyId?: string;
  onAt: (at: KitAt) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
};

export const FIRST_NOTE = "Already first.";
export const LAST_NOTE = "Already last.";
export const ONLY_NOTE = "The only segment in the kit.";

export function KitEntryRow({
  entry,
  position,
  total,
  segment,
  aheadOf,
  disabled,
  busyId,
  onAt,
  onMove,
  onRemove,
}: Props) {
  const name = segment?.name ?? GONE_NAME;
  const edgeId = useId();
  const first = position === 1;
  const last = position === total;
  const edge =
    first && last ? ONLY_NOTE : first ? FIRST_NOTE : last ? LAST_NOTE : null;
  const busy = disabled ? { "aria-describedby": busyId } : undefined;
  const edgeOf = (at: boolean) =>
    !disabled && at ? { "aria-describedby": edgeId } : busy;
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
        <SegmentedControl label={`Where ${name} goes`} className="kit-entry-at">
          {(["start", "end"] as const).map((at) => (
            <ToggleButton
              key={at}
              pressed={entry.at === at}
              disabledReason={disabled ? "Saving the kit." : undefined}
              {...busy}
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
            disabled ? "Saving the kit." : first ? FIRST_NOTE : undefined
          }
          {...edgeOf(first)}
          onClick={() => onMove(-1)}
        >
          <SystemIcon name="chevron-up" size={16} />
        </Button>
        <Button
          className="kit-icon-button"
          data-move="down"
          aria-label={`Move ${name} down`}
          disabledReason={
            disabled ? "Saving the kit." : last ? LAST_NOTE : undefined
          }
          {...edgeOf(last)}
          onClick={() => onMove(1)}
        >
          <SystemIcon name="chevron-down" size={16} />
        </Button>
        <Button
          className="kit-icon-button"
          data-remove
          aria-label={`Remove ${name} from the kit`}
          disabledReason={disabled ? "Saving the kit." : undefined}
          {...busy}
          onClick={onRemove}
        >
          <SystemIcon name="trash-2" size={16} />
        </Button>
      </div>
      {edge ? (
        <p id={edgeId} className="kit-problem kit-entry-edge">
          {edge}
        </p>
      ) : null}
      {aheadOf ? (
        <p className="kit-problem kit-entry-warning" role="note">
          {startOrderNote(name, aheadOf)}
        </p>
      ) : null}
    </li>
  );
}
