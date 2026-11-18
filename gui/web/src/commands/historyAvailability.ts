import { hasDocumentDrafts } from "../document/pendingDrafts";
import { canApplyPass12 } from "../shareMode";
import { documentActivityBusy } from "../state/documentSendOrder";
import type { DawStore } from "../state/types";

export type HistoryMoveAvailability =
  | { ok: true }
  | { ok: false; reason: string };

export type HistoryAvailability = {
  undo: HistoryMoveAvailability;
  redo: HistoryMoveAvailability;
};

const NEEDS_EDITOR = {
  undo: "Undo needs Editor access",
  redo: "Redo needs Editor access",
} as const;

const NOTHING = {
  host: { undo: "Nothing to undo", redo: "Nothing to redo" },
  guest: {
    undo: "There is nothing of yours to undo. The latest change is someone else's.",
    redo: "There is nothing of yours to redo. Redo brings back only what you undid.",
  },
} as const;

export function editUnsaved(projectPath: string): boolean {
  return documentActivityBusy(projectPath) || hasDocumentDrafts();
}

/** The role check alone: a toast's Undo runs without the head flags. */
export function historyRoleRefusal(
  s: HistoryState,
  action: "undo" | "redo",
): string | null {
  return canApplyHistoryRole(s) ? null : NEEDS_EDITOR[action];
}

function canApplyHistoryRole(s: HistoryState): boolean {
  return canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities);
}

type HistoryState = Pick<
  DawStore,
  "project" | "projectPath" | "guestMode" | "shareCapabilities"
>;

/**
 * The one answer to "can this tab Undo or Redo right now". The keys, palette
 * rows, two-finger tap, header, Inspector sheet and History tab all read it.
 * A save in flight counts for Undo in every role: it will be this person's own
 * step by the time the press runs.
 */
export function historyAvailability(s: HistoryState): HistoryAvailability {
  if (!canApplyHistoryRole(s)) {
    return {
      undo: { ok: false, reason: NEEDS_EDITOR.undo },
      redo: { ok: false, reason: NEEDS_EDITOR.redo },
    };
  }
  const words = s.guestMode != null ? NOTHING.guest : NOTHING.host;
  const history = s.project?.history;
  const canUndo = (history?.can_undo ?? false) || editUnsaved(s.projectPath);
  const canRedo = history?.can_redo ?? false;
  return {
    undo: canUndo ? { ok: true } : { ok: false, reason: words.undo },
    redo: canRedo ? { ok: true } : { ok: false, reason: words.redo },
  };
}
