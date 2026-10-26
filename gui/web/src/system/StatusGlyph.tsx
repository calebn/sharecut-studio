import { SystemIcon } from "./SystemIcon";
import type { StatusState } from "./statusText";
import { STATUS_GLYPHS } from "./verbs";

type Props = {
  state: StatusState;
  /** The 8 px dot that badges use for "needs you". */
  dot?: boolean;
  progress?: number;
  size?: number;
};

/** The one status glyph set (design system 4.6). Shape differs per state, never colour alone. */
export function StatusGlyph({ state, dot, progress, size = 16 }: Props) {
  const entry = STATUS_GLYPHS.find((glyph) => glyph.state === state);
  if (!entry) return null;
  if (dot && state === "needs-you") {
    return <span className="sys-glyph sys-glyph--dot sys-tone-warning" />;
  }
  return (
    <span className={`sys-glyph sys-tone-${entry.tone}`}>
      <SystemIcon name={entry.glyph} size={size} progress={progress} />
    </span>
  );
}
