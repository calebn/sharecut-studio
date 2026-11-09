import { isRangeSelection } from "../edit/rangeSelection";
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
  const rangeFields = rangeActionsInSheet && !isRangeSelection(selection);
  return (
    <>
      {rangeFields ? <RangeFields sheet /> : null}
      {selection != null && !(rangeArmed && selection.kind === "track") ? (
        <Inspector placement="sheet" />
      ) : null}
    </>
  );
}
