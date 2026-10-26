import { SegmentedControl, ToggleButton } from "../ui";
import {
  type AuditionSegment,
  type AuditionSide,
  auditionSegments,
  REVIEW_PAD_S,
} from "./auditionWindow";
import type { SuggestionRange } from "./silenceSnap";

export type AbAuditionProps = {
  side: AuditionSide;
  change: SuggestionRange;
  /** The person chose a side: A or B was tapped or its key pressed. */
  onSelect: (side: AuditionSide, segments: AuditionSegment[]) => void;
  pad?: number;
  disabled?: boolean;
};

/** A two-segment control: A is before, B is after. Moving a handle switches it to B. */
export function AbAudition({
  side,
  change,
  onSelect,
  pad = REVIEW_PAD_S,
  disabled = false,
}: AbAuditionProps) {
  const choose = (next: AuditionSide) => () =>
    onSelect(next, auditionSegments(next, change, pad));
  const reason = disabled ? "Nothing to hear yet" : undefined;
  return (
    <div className="sys-ab">
      <SegmentedControl label="Audition">
        <ToggleButton
          quiet
          pressed={side === "A"}
          title="Hear before (A)"
          aria-keyshortcuts="A"
          disabledReason={reason}
          onClick={choose("A")}
        >
          A
        </ToggleButton>
        <ToggleButton
          quiet
          pressed={side === "B"}
          title="Hear after (B)"
          aria-keyshortcuts="B"
          disabledReason={reason}
          onClick={choose("B")}
        >
          B
        </ToggleButton>
      </SegmentedControl>
      <span className="sys-ab-note">{pad} s before and after</span>
    </div>
  );
}
