import { useId } from "react";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { FadeCurve } from "../../types/project";
import { SegmentedControl, ToggleButton } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import {
  FADE_CURVES,
  type FadeEdge,
  fadeCurveLabel,
  fadeCurveTitle,
} from "../../utils/fadeCurves";

type Rows = InspectorSection["rows"];

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
        <FadeShapePicker
          name={name}
          curve={curve}
          disabledReason={disabledReason}
          onPick={onPick}
        />
      ),
    },
  ];
}

function FadeShapePicker({
  name,
  curve,
  disabledReason,
  onPick,
}: {
  name: string;
  curve: FadeCurve | null;
  disabledReason: string | undefined;
  onPick: (curve: FadeCurve) => void;
}) {
  const reasonId = useId();
  const visibleReason =
    disabledReason !== undefined && disabledReason !== BUSY_REASON
      ? disabledReason
      : undefined;
  return (
    <div className="fade-shape">
      <SegmentedControl label={name}>
        {FADE_CURVES.map((option) => (
          <ToggleButton
            key={option}
            quiet
            pressed={option === curve}
            title={fadeCurveTitle(option)}
            aria-label={fadeCurveLabel(option)}
            aria-describedby={
              visibleReason === undefined ? undefined : reasonId
            }
            disabledReason={disabledReason}
            onClick={() => onPick(option)}
          >
            {fadeCurveLabel(option)}
          </ToggleButton>
        ))}
      </SegmentedControl>
      {curve === null ? <span className="fade-shape-mixed">Mixed</span> : null}
      {visibleReason === undefined ? null : (
        <span id={reasonId} className="fade-shape-reason">
          {visibleReason}
        </span>
      )}
    </div>
  );
}
