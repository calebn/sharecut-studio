import {
  FADE_CURVES,
  type FadeEdge,
  fadeCurveLabel,
  fadeCurveTitle,
} from "../../edit/fadeCurves";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { FadeCurve } from "../../types/project";
import { SegmentedControl, ToggleButton } from "../../ui";

type Rows = InspectorSection["rows"];

/**
 * The shape picker of one fade edge. `curve` is the shape in force, `null`
 * when several clips differ (nothing is pressed and "Mixed" shows).
 * `ignored` is why a cut or a blended join stops the shape applying: the
 * saved shape stays pressed and the buttons are disabled with that reason.
 * A Viewer reads the shape as text.
 */
export function fadeCurveRows({
  edge,
  curve,
  editable,
  disabledReason,
  onPick,
}: {
  edge: FadeEdge;
  curve: FadeCurve | null;
  editable: boolean;
  /** Why the buttons are disabled (busy, a cut or blended join), or undefined. */
  disabledReason: string | undefined;
  onPick: (curve: FadeCurve) => void;
}): Rows {
  const label = edge === "in" ? "Fade in shape" : "Fade out shape";
  const id = edge === "in" ? "fadeCurveIn" : "fadeCurveOut";
  const name = curve === null ? `${label}, Mixed` : label;
  if (!editable)
    return [
      {
        id,
        label,
        control: curve === null ? "Mixed" : fadeCurveLabel(curve),
      },
    ];
  return [
    {
      id,
      label,
      control: (
        <div className="fade-shape">
          <SegmentedControl label={name}>
            {FADE_CURVES.map((option) => (
              <ToggleButton
                key={option}
                quiet
                pressed={option === curve}
                title={fadeCurveTitle(option)}
                aria-label={fadeCurveLabel(option)}
                disabledReason={disabledReason}
                onClick={() => onPick(option)}
              >
                {fadeCurveLabel(option)}
              </ToggleButton>
            ))}
          </SegmentedControl>
          {curve === null ? (
            <span className="fade-shape-mixed">Mixed</span>
          ) : null}
        </div>
      ),
    },
  ];
}
