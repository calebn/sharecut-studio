import { isRangeSelection } from "../edit/rangeSelection";
import { useDaw } from "../state/useDaw";
import { RangeActions } from "../timeline/RangeActions";
import { Inspector } from "./Inspector";
import { RelatedCommands } from "./RelatedCommands";

/**
 * The selection sheet's body on every touch shell: Select range's In and Out
 * fields while it is armed, the selection's inspector, then the commands
 * related to it. The range controls live here, never in a bar behind the
 * sheet's scrim.
 */
export function SelectionSheetBody() {
  const { selection, rangeArmed } = useDaw((s) => ({
    selection: s.selection,
    rangeArmed: s.rangeArmed,
  }));
  const rangeFields = rangeArmed && !isRangeSelection(selection);
  return (
    <>
      {rangeFields ? <RangeActions sheet /> : null}
      {selection != null ? <Inspector /> : null}
      {rangeArmed ? null : <RelatedCommands selection={selection} />}
    </>
  );
}
