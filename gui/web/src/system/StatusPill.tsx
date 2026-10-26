import { StatusGlyph } from "./StatusGlyph";
import type { StatusState } from "./statusText";

export type StatusPillProps = {
  state: StatusState;
  /** Short and plain: "Review 6", "Saving · 2 of 3". */
  text: string;
  /** 0 to 1, drawn in the glyph while `running`. */
  progress?: number;
};

/** A short persistent state: glyph and text. The glyph shape differs per state. */
export function StatusPill({ state, text, progress }: StatusPillProps) {
  return (
    <span className="sys-pill" data-state={state}>
      <StatusGlyph state={state} progress={progress} size={14} />
      <span className="sys-pill-text">{text}</span>
    </span>
  );
}
