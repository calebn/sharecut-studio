/**
 * The ripple mark (#1135, trim mode Option A "wave and flatline"): a wave,
 * sound carrying on, plus the word, wherever an edit moves the later clips.
 * The one place the mark is drawn, so the trim-mode icon set (#1138) swaps
 * in here.
 */
import { Icon } from "./Icon";

export function RippleMark({
  /** Extra words after the mark, such as "later −6.7 s". */
  detail,
}: {
  detail?: string;
}) {
  return (
    <span className="ripple-mark">
      <Icon name="ripple" className="ripple-mark-icon" aria-hidden="true" />
      <span className="ripple-mark-text">Ripple</span>
      {detail ? <span className="ripple-mark-detail">{detail}</span> : null}
    </span>
  );
}
