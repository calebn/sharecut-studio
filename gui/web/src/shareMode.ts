/** Virtual project keys for token-scoped guest ShareCut Studio (`share:{token}`). */

import type { Capability } from "./types/roles.generated";
import {
  type Audience,
  audienceOf,
  can,
  holds,
  isGuestAudience,
  isHost,
  isShareProjectKey,
  SHARE_PREFIX,
} from "./utils/can";

/** Server ``guest_mode``: Editor ``edit``, Commenter ``comment``, Viewer ``view``. */
export type GuestMode = "edit" | "comment" | "view" | "none";

export function shareProjectKey(token: string): string {
  return `${SHARE_PREFIX}${token}`;
}

export { isShareProjectKey, SHARE_PREFIX };

export function shareTokenFromKey(projectPath: string): string | null {
  if (!isShareProjectKey(projectPath)) {
    return null;
  }
  return projectPath.slice(SHARE_PREFIX.length);
}

/** Who this session comments as. */
export type CommentRole = Audience;

/** `guest` on a share route, share project key or guest mode; else `host`. */
export function commentRole(
  projectPath: string,
  guestMode: string | null,
  guestShare = false,
): CommentRole {
  return audienceOf(projectPath, guestMode, guestShare);
}

/** True on a share route, share key or guest mode: the session reads and comments as a guest. */
export function isGuestSession(
  projectPath: string,
  guestMode: string | null,
  guestShare = false,
): boolean {
  return isGuestAudience(commentRole(projectPath, guestMode, guestShare));
}

export { reviewApiBase } from "./shareRoute";

/** The server's answer (`reads_transcript_words`), not a rule: host sessions read, a share reads when the bootstrap said so. */
export function readsTranscriptWords(
  projectPath: string,
  granted: boolean,
): boolean {
  return !isShareProjectKey(projectPath) || granted;
}

/** Mirrors ``has_capability`` (view→play, comment→reply). */
export function hasShareCapability(
  capabilities: string[] | null | undefined,
  cap: string,
): boolean {
  return holds(capabilities, cap);
}

function shareGranted(
  projectPath: string,
  capabilities: string[] | null | undefined,
  cap: Capability,
): boolean {
  return can(cap, { projectPath, capabilities });
}

/** Share guests hear Full mix only — never Edited stems / Original. */
export function guestHearsMixOnly(guestMode: string | null): boolean {
  return guestMode != null;
}

/** Host (non-share) or an Editor (``edit``) may apply Pass 1–2 mutations. */
export function canApplyPass12(
  projectPath: string,
  _guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return shareGranted(projectPath, capabilities, "edit");
}

/**
 * Approve / Reject any pending edit, exact ranges included. Approving applies an
 * edit, so it mirrors the server's ``may_decide_exact_range``: host or Editor.
 */
export function canReviewPendingEdit(
  projectPath: string,
  capabilities: string[] | null | undefined,
): boolean {
  return rangeEditMode(projectPath, capabilities) === "edit";
}

/** Host / Editor apply structural timeline ops; a Commenter proposes. */
export function canApplyStructural(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host, Commenter or Editor may run structural commands (apply or propose). */
export function canSuggestStructural(
  projectPath: string,
  _guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return (
    shareGranted(projectPath, capabilities, "suggest") ||
    shareGranted(projectPath, capabilities, "edit")
  );
}

/**
 * What a selected range (timeline or transcript words) can do in this session.
 * Mirrors the server's ``resolve_range_mode``: host or Editor applies, a
 * Commenter proposes for review, anything else cannot select for edits.
 */
export type RangeEditMode = "edit" | "suggest" | "none";

export function rangeEditMode(
  projectPath: string,
  capabilities: string[] | null | undefined,
): RangeEditMode {
  if (canApplyPass12(projectPath, null, capabilities)) return "edit";
  if (canSuggestStructural(projectPath, null, capabilities)) return "suggest";
  return "none";
}

/**
 * Mirrors the server's ``authorize_pending_update``: host or Editor retimes any
 * pending edit; a Commenter retimes only edits its own share authored
 * (``editAuthor`` equals this session's ``shareAuthor``).
 */
export function canRetimePendingEdit(
  projectPath: string,
  capabilities: string[] | null | undefined,
  shareAuthor: string | null | undefined,
  editAuthor: string | null | undefined,
): boolean {
  if (canApplyPass12(projectPath, null, capabilities)) return true;
  return (
    canSuggestStructural(projectPath, null, capabilities) &&
    shareAuthor != null &&
    editAuthor === shareAuthor
  );
}

/** Host-only mutations (markers, transcript, FX). */
export function canHostMutate(projectPath: string): boolean {
  return isHost({ projectPath });
}

/**
 * Host or an Editor may change volume envelopes, as the server's
 * ``EDIT_COMMANDS`` allows ``SetEnvelope`` (owner decision, #1051).
 */
export function canEditEnvelopes(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host or Docs Editor may rebuild stems/premix (render_preview). */
export function canRefreshMix(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host or an Editor may change the saved mix (track volume, mute). */
export function canEditMix(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host or an Editor may add tracks / import audio. */
export function canIngestMedia(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host-only New/Open project (not share guests). */
export function canManageProjects(projectPath: string): boolean {
  return isHost({ projectPath });
}

/** ``canSuggestStructural`` plus a loaded project (blade / delete / tool cluster). */
export function canSuggestStructuralOnProject(
  projectPath: string,
  guestMode: string | null,
  capabilities: string[] | null | undefined,
  hasProject: boolean,
): boolean {
  return (
    hasProject && canSuggestStructural(projectPath, guestMode, capabilities)
  );
}

/** Host, or guest with the ``comment`` capability (create / Ask). */
export function canComment(
  projectPath: string,
  _guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return shareGranted(projectPath, capabilities, "comment");
}

/** Host, or guest with ``comment`` or ``reply`` (thread on an existing comment). */
export function canReply(
  projectPath: string,
  _guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return shareGranted(projectPath, capabilities, "reply");
}

/** Host, or guest with the ``action`` capability (check off comment TODOs). */
export function canSetAction(
  projectPath: string,
  capabilities?: string[] | null,
): boolean {
  return shareGranted(projectPath, capabilities, "action");
}
