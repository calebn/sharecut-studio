import { SegmentedControl, ToggleButton } from "../ui";
import { type AuditionSide, auditionSegments } from "./auditionWindow";
import type { TimeRange } from "./seconds";
import { hintOf, verbOf } from "./verbDisplay";

export type AbAuditionProps = {
  side: AuditionSide;
  change: TimeRange;
  /** Called on a tap or key press of A or B. */
  onSelect: (side: AuditionSide, segments: TimeRange[]) => void;
};

/** Moving a waveform handle switches it to B. */
export function AbAudition({ side, change, onSelect }: AbAuditionProps) {
  const before = verbOf("hearBefore");
  const after = verbOf("hearAfter");
  const choose = (next: AuditionSide) => () =>
    onSelect(next, auditionSegments(next, change));
  return (
    <div className="sys-ab">
      <SegmentedControl label="Audition">
        <ToggleButton
          quiet
          pressed={side === "A"}
          title={`${before.label}${hintOf(before)}`}
          aria-keyshortcuts={before.keys[0]?.key}
          onClick={choose("A")}
        >
          A
        </ToggleButton>
        <ToggleButton
          quiet
          pressed={side === "B"}
          title={`${after.label}${hintOf(after)}`}
          aria-keyshortcuts={after.keys[0]?.key}
          onClick={choose("B")}
        >
          B
        </ToggleButton>
      </SegmentedControl>
      <span className="sys-ab-note">3 s before and after</span>
    </div>
  );
}
