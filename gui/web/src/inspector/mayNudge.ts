import type { NudgeField } from "../edit/nudge";
import {
  canApplyPass12,
  canEditEnvelopes,
  canRetimePendingEdit,
} from "../shareMode";
import type { DawState } from "../state/types";
import type { ProjectView } from "../types/project";

type Access = Pick<
  DawState,
  | "projectPath"
  | "guestMode"
  | "shareCapabilities"
  | "shareAuthor"
  | "joinMutationInFlight"
>;

/** May the current user change `field`? The strip's nudges and a precision drag ask. */
export function mayNudge(s: Access, project: ProjectView, field: NudgeField) {
  switch (field.kind) {
    case "fade":
    case "trim":
      return (
        canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) &&
        !s.joinMutationInFlight
      );
    case "pending": {
      const edit = project.pending_edits.find((e) => e.id === field.editId);
      return (
        edit != null &&
        canRetimePendingEdit(
          s.projectPath,
          s.shareCapabilities,
          s.shareAuthor,
          edit.author,
        )
      );
    }
    case "envelope-time":
    case "envelope-level":
      return canEditEnvelopes(s.projectPath, s.guestMode, s.shareCapabilities);
  }
}
