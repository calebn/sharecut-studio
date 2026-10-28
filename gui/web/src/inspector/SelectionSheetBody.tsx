import { isRangeSelection } from "../edit/rangeSelection";
import { useDaw } from "../state/useDaw";
import { RangeFields } from "../timeline/RangeFields";
import { Inspector } from "./Inspector";
import { InspectorPeek } from "./InspectorPeek";
import type { PeekTarget } from "./peekTarget";
import { RelatedCommands } from "./RelatedCommands";

export function SelectionSheetBody({
  rangeActionsInSheet,
  peek,
}: {
  rangeActionsInSheet: boolean;
  peek: PeekTarget | null;
}) {
  const { selection, rangeArmed } = useDaw((s) => ({
    selection: s.selection,
    rangeArmed: s.rangeArmed,
  }));
  const rangeFields = rangeActionsInSheet && !isRangeSelection(selection);
  return (
    <>
      {rangeFields ? <RangeFields sheet /> : null}
      {peek ? (
        <InspectorPeek peek={peek} />
      ) : selection != null && !(rangeArmed && selection.kind === "track") ? (
        <Inspector placement="sheet" />
      ) : null}
      {rangeArmed || peek ? null : <RelatedCommands selection={selection} />}
    </>
  );
}
