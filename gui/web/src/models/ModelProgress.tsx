import { progressText } from "./format";
import type { ModelState } from "./types";

/**
 * A real byte bar for a model that is downloading, indeterminate while the total is unknown. The
 * spoken value is "420 MB of 1.6 GB". It is not a live region, so bytes arriving never speak.
 */
export function ModelProgress({
  state,
  label,
}: {
  state: Extract<ModelState, { kind: "downloading" }>;
  /** Names the bar, usually the model's label. */
  label: string;
}) {
  return (
    <span className="model-row-progress">
      <progress
        aria-label={label}
        aria-valuetext={progressText(state)}
        {...(state.total != null
          ? { value: state.bytes, max: state.total }
          : {})}
      />
      <span className="model-row-bytes">{progressText(state)}</span>
    </span>
  );
}
