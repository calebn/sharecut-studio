import { SegmentedControl, ToggleButton } from "../ui";
import { type AuditionSide, auditionSegments } from "./auditionWindow";
import type { TimeRange } from "./seconds";
import { hintOf, verbOf } from "./verbDisplay";

export type AbAuditionProps = {
  side: AuditionSide;
  change: TimeRange;
  /** Called on a tap or key press of A or B. */
  onSelect: (side: AuditionSide, segments: TimeRange[]) => void;
  /** What the caption says about the window; the review default names the 3 s of context. */
  note?: string;
  /** Show the A and B key hints. Off where the keys do not reach the compared object. */
  shortcuts?: boolean;
};

const DEFAULT_NOTE = "3 s before and after";

/** Moving a waveform handle switches it to B. */
export function AbAudition({
  side,
  change,
  onSelect,
  note = DEFAULT_NOTE,
  shortcuts = true,
}: AbAuditionProps) {
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
          title={shortcuts ? `${before.label}${hintOf(before)}` : before.label}
          aria-keyshortcuts={shortcuts ? before.keys[0]?.key : undefined}
          onClick={choose("A")}
        >
          <span className="sys-ab-glyph">A</span>
        </ToggleButton>
        <ToggleButton
          quiet
          pressed={side === "B"}
          title={shortcuts ? `${after.label}${hintOf(after)}` : after.label}
          aria-keyshortcuts={shortcuts ? after.keys[0]?.key : undefined}
          onClick={choose("B")}
        >
          <span className="sys-ab-glyph">B</span>
        </ToggleButton>
      </SegmentedControl>
      <span className="sys-ab-note">{note}</span>
    </div>
  );
}
