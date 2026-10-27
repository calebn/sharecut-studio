import { clampUnit } from "./progress";
import { SystemIcon } from "./SystemIcon";
import { STATUS_TEXT, type StatusState } from "./statusText";
import { STATUS_GLYPHS } from "./verbs";

type Props = {
  state: StatusState;
  /** The 8 px dot that badges use for "needs you". */
  dot?: boolean;
  /** 0 to 1; held to that range. */
  progress?: number;
  size?: number;
  /** The state's name for assistive tech. `false` when the caller names it. */
  text?: string | false;
  /** Follow the hidden name with ": " when text comes right after it. */
  colon?: boolean;
};

/** The one status glyph set (design system 4.6). Shape differs per state, never colour alone. */
export function StatusGlyph({
  state,
  dot,
  progress,
  size = 16,
  text = STATUS_TEXT[state],
  colon = false,
}: Props) {
  const entry = STATUS_GLYPHS.find((glyph) => glyph.state === state);
  if (!entry) return null;
  const name =
    text === false ? null : (
      <>
        <span className="sr-only">{text}</span>
        {colon ? <span className="sr-only">: </span> : null}
      </>
    );
  if (dot && state === "needs-you") {
    return (
      <span className="sys-glyph sys-glyph--dot sys-tone-warning">{name}</span>
    );
  }
  return (
    <span className={`sys-glyph sys-tone-${entry.tone}`}>
      <SystemIcon
        name={entry.glyph}
        size={size}
        progress={progress === undefined ? undefined : clampUnit(progress)}
      />
      {name}
    </span>
  );
}
