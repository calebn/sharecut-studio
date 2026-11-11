import type { InspectorSection } from "../../system/InspectorSheet";
import type { FadeCurve } from "../../types/project";
import { type FadeEdge, fadeCurveLabel } from "../../utils/fadeCurves";
import { FadeShapePicker } from "./FadeShapePicker";

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
