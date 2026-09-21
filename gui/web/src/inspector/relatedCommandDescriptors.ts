import { COMMANDS } from "../commands/catalog";
import type { Selection } from "../types/project";

export type RelatedCommandDescriptor = {
  commandId: keyof typeof COMMANDS;
  args: Record<string, unknown>;
  /** Related actions always honor the command catalog's availability gate. */
  respectWhen: true;
};

const COPY_SELECTION: RelatedCommandDescriptor = {
  commandId: "edit.copy",
  args: {},
  respectWhen: true,
};

/**
 * Secondary actions for the mobile selection-sheet Related zone.
 *
 * Keep this deliberately small: inspectors own their primary mutations, and
 * every entry here must be a live command-bus action for this exact selection.
 */
export function relatedCommandsFor(
  selection: Selection | null,
): readonly RelatedCommandDescriptor[] {
  switch (selection?.kind) {
    case "clip":
    case "transcriptWord":
      return [COPY_SELECTION];
    default:
      return [];
  }
}

/**
 * Overflow is intentionally separate from Related actions. None of the
 * current inspector selections has an additional command-bus action that is
 * both selection-specific and not already primary (or an inspector footer).
 * Keep this function so a future supported command cannot silently become a
 * duplicate button in the Related zone.
 */
export function moreCommandsFor(
  _selection: Selection | null,
): readonly RelatedCommandDescriptor[] {
  return [];
}
