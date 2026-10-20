import type { RoutedTarget } from "../timeline/hitRouting";
import type { ProjectView, Selection } from "../types/project";
import type { PeekTarget } from "./peekBuilders";
import { surfaceOf } from "./selectionSurface";

export type { PeekNudgeRow, PeekTarget } from "./peekBuilders";

/**
 * What the phone peek strip shows for `selection`, read from its kind's
 * `SELECTION_SURFACES` row. `null` for a kind with no peek; that one opens the
 * full inspector.
 */
export function peekTarget(
  project: ProjectView,
  selection: Selection,
  hit: RoutedTarget | null,
): PeekTarget | null {
  return selection
    ? (surfaceOf(selection).peek?.(selection, project, hit) ?? null)
    : null;
}
