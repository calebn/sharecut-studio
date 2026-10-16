import { isRangeSelection } from "../edit/rangeSelection";
import { useDaw } from "../state/useDaw";
import { RangeActions } from "../timeline/RangeActions";
import { Inspector } from "./Inspector";
import { RelatedCommands } from "./RelatedCommands";

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
      {rangeFields ? <RangeActions sheet /> : null}
      {selection != null ? <Inspector /> : null}
      {rangeArmed ? null : <RelatedCommands selection={selection} />}
    </>
  );
}
