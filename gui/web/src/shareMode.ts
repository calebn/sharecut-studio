/** Virtual project keys for token-scoped guest Sharecut Studio (`share:{token}`). */

export const SHARE_PREFIX = "share:";

export type GuestMode = "edit" | "suggest" | "view" | "comment" | "none";

export function shareProjectKey(token: string): string {
  return `${SHARE_PREFIX}${token}`;
}

export function isShareProjectKey(projectPath: string): boolean {
  return projectPath.startsWith(SHARE_PREFIX);
}

export function shareTokenFromKey(projectPath: string): string | null {
  if (!isShareProjectKey(projectPath)) {
    return null;
  }
  return projectPath.slice(SHARE_PREFIX.length);
}

export { reviewApiBase } from "./shareRoute";

/** Mirrors ``has_capability`` (view→play, comment→reply). */
export function hasShareCapability(
  capabilities: string[] | null | undefined,
  cap: string,
): boolean {
  const s = new Set(capabilities ?? []);
  if (cap === "play" && s.has("view")) {
    return true;
  }
  if (cap === "reply" && s.has("comment")) {
    return true;
  }
  return s.has(cap);
}

function shareGranted(
  projectPath: string,
  capabilities: string[] | null | undefined,
  cap: string,
): boolean {
  if (!isShareProjectKey(projectPath)) {
    return true;
  }
  if (capabilities == null) {
    return false;
  }
  return hasShareCapability(capabilities, cap);
}

/** Share guests hear Mix only — never FX/Raw. */
export function guestHearsMixOnly(guestMode: string | null): boolean {
  return guestMode != null;
}

/** Label for the guest share banner (not always read-only). */
export function guestShareBannerLabel(guestMode: string | null): string {
  switch (guestMode) {
    case "edit":
      return "Shared edit view · You can add tracks and audio";
    case "suggest":
      return "Shared suggest view";
    case "view":
      return "Shared read-only view";
    case "comment":
      return "Shared comment view";
    default:
      return "Shared view";
  }
}

/** Host (non-share) or guest with ``edit`` may apply Pass 1–2 mutations. */
export function canApplyPass12(
  projectPath: string,
  _guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return shareGranted(projectPath, capabilities, "edit");
}

/** Host / edit apply structural timeline ops; suggest-only proposes. */
export function canApplyStructural(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host or suggest/edit may run structural commands (apply or propose). */
export function canSuggestStructural(
  projectPath: string,
  _guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  if (!isShareProjectKey(projectPath)) {
    return true;
  }
  if (capabilities == null) {
    return false;
  }
  return (
    hasShareCapability(capabilities, "suggest") ||
    hasShareCapability(capabilities, "edit")
  );
}

/** Host or guest with ``suggest``/``edit`` may nudge pending / suggest cuts. */
export function canSuggestOrNudge(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canSuggestStructural(projectPath, guestMode, capabilities);
}

/** Host-only mutations (envelopes, markers, transcript, FX). */
export function canHostMutate(projectPath: string): boolean {
  return !isShareProjectKey(projectPath);
}

/** Host or Docs Editor may rebuild stems/premix (render_preview). */
export function canRefreshMix(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host or guest ``edit`` may change the saved mix (track volume, mute). */
export function canEditMix(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host or guest ``edit`` may add tracks / import audio. */
export function canIngestMedia(
  projectPath: string,
  guestMode: string | null,
  capabilities?: string[] | null,
): boolean {
  return canApplyPass12(projectPath, guestMode, capabilities);
}

/** Host-only New/Open project (not share guests). */
export function canManageProjects(projectPath: string): boolean {
  return !isShareProjectKey(projectPath);
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
