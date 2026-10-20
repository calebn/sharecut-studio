import type { CommandContext } from "../commands/context";
import type { ProjectView, Selection } from "../types/project";
import type { RelatedCommandDescriptor } from "./relatedRows";
import { surfaceOf } from "./selectionSurface";

export type { RelatedCommandDescriptor } from "./relatedRows";

/**
 * Secondary actions for the selection-sheet Related zone, read from the
 * selection's `SELECTION_SURFACES` row.
 *
 * Keep this deliberately small: inspectors own their primary mutations, and
 * every entry here must be a live command-bus action for this exact selection.
 */
export function relatedCommandsFor(
  selection: Selection | null,
): readonly RelatedCommandDescriptor[] {
  return selection ? surfaceOf(selection).related(selection) : [];
}

/** Only expose actions for the selection currently owned by the command bus. */
function isLiveSelection(selection: Selection, live: Selection): boolean {
  if (selection?.kind !== live?.kind) {
    return false;
  }
  if (selection?.kind === "clip" && live?.kind === "clip") {
    return selection.id === live.id && selection.trackId === live.trackId;
  }
  if (selection?.kind === "track" && live?.kind === "track") {
    return selection.trackId === live.trackId;
  }
  return false;
}

/** Selection-specific overflow; inspector actions and Related Copy stay separate. */
export function moreCommandsFor(
  selection: Selection,
  liveSelection: Selection,
  project: ProjectView | null,
  context: CommandContext,
): readonly RelatedCommandDescriptor[] {
  if (!selection || !project || !isLiveSelection(selection, liveSelection)) {
    return [];
  }
  return surfaceOf(selection).more(selection, project, context);
}
