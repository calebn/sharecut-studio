/**
 * Gap trim mark (#1135 Option A): a broken flatline where later clips stay put.
 * Paired with {@link RippleMark} for the trim-mode icon vocabulary (#1138).
 */
import { Icon } from "./Icon";

export function GapMark({
  /** Extra words after the mark, such as "gap +0.4 s". */
  detail,
}: {
  detail?: string;
}) {
  return (
    <span className="gap-mark">
      <Icon name="flatline" className="gap-mark-icon" aria-hidden="true" />
      <span className="gap-mark-text">Gap</span>
      {detail ? <span className="gap-mark-detail">{detail}</span> : null}
    </span>
  );
}
