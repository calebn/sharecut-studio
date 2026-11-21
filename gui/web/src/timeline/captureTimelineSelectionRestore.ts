import { rangeIsCurrent } from "../edit/rangeSelection";
import { captureSelectionRestore } from "../state/selectionSlice";

type SelectionRestoreState = Parameters<typeof captureSelectionRestore>[0];

export function captureTimelineSelectionRestore(state: SelectionRestoreState) {
  const restore = captureSelectionRestore(state);
  return (current: SelectionRestoreState) => {
    const selection = restore(current);
    if (
      selection?.kind === "range" &&
      (!current.project || !rangeIsCurrent(current.project, selection.target))
    ) {
      return null;
    }
    return selection;
  };
}
