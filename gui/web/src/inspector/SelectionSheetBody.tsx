import { useDaw } from "../state/useDaw";
import { RangeFields } from "../timeline/RangeFields";
import { Inspector } from "./Inspector";

export function SelectionSheetBody({
  rangeActionsInSheet,
}: {
  rangeActionsInSheet: boolean;
}) {
  const { selection, rangeArmed } = useDaw((s) => ({
    selection: s.selection,
    rangeArmed: s.rangeArmed,
  }));
  const rangeFields =
    rangeActionsInSheet && selection?.kind !== "transcriptRange";
  return (
    <>
      {rangeFields ? (
        <RangeFields sheet always={selection?.kind === "range"} />
      ) : null}
      {selection != null &&
      selection.kind !== "range" &&
      !(rangeArmed && selection.kind === "track") ? (
        <Inspector placement="sheet" />
      ) : null}
    </>
  );
}
