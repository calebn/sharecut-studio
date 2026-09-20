import {
  canApplyPass12,
  canIngestMedia,
  canManageProjects,
  canRefreshMix,
  canSuggestStructural,
  isShareProjectKey,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ContextPredicateId } from "./types";

export type CommandContext = {
  timelineFocused: boolean;
  transcriptFocused: boolean;
  layoutFocused: boolean;
  commentMode: boolean;
  canSuggestStructural: boolean;
  canApplyPass12: boolean;
  canRefreshMix: boolean;
  canIngestMedia: boolean;
  canManageProjects: boolean;
  hasProject: boolean;
  shellBreakpoint: string;
  playheadSec: number;
  timelineDurationSec: number;
  projectPath: string;
  guestMode: string | null;
  bladeConfirmSec: number | null;
  /** Inspector selection is a track (header clicked). */
  trackInspectorSelected: boolean;
  /** Inspector-selected track has a lane above it. */
  canMoveSelectedTrackUp: boolean;
  /** Inspector-selected track has a lane below it. */
  canMoveSelectedTrackDown: boolean;
  /** Any inspector selection (clip, track, comment, …). */
  hasInspectorSelection: boolean;
  following: boolean;
  recordPanelOpen: boolean;
  tightenPanelOpen: boolean;
};

export function buildCommandContext(): CommandContext {
  const s = useDawStore.getState();
  const transcriptFocused = s.activeTab === "transcript";
  const selection = s.selection;
  const selectedTrackIndex =
    selection?.kind === "track"
      ? (s.project?.tracks.findIndex(
          (track) => track.id === selection.trackId,
        ) ?? -1)
      : -1;
  return {
    timelineFocused: s.timelineFocused,
    transcriptFocused,
    layoutFocused: s.timelineFocused || transcriptFocused,
    commentMode: s.commentMode,
    canSuggestStructural: canSuggestStructural(
      s.projectPath,
      s.guestMode,
      s.shareCapabilities,
    ),
    canApplyPass12: canApplyPass12(
      s.projectPath,
      s.guestMode,
      s.shareCapabilities,
    ),
    canRefreshMix: canRefreshMix(
      s.projectPath,
      s.guestMode,
      s.shareCapabilities,
    ),
    canIngestMedia: canIngestMedia(
      s.projectPath,
      s.guestMode,
      s.shareCapabilities,
    ),
    canManageProjects: canManageProjects(s.projectPath),
    hasProject: s.project != null,
    shellBreakpoint: s.shellBreakpoint,
    playheadSec: s.playheadSec,
    timelineDurationSec: s.project?.timeline_duration_sec ?? Infinity,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    bladeConfirmSec: s.bladeConfirmSec,
    trackInspectorSelected: selection?.kind === "track",
    canMoveSelectedTrackUp: selectedTrackIndex > 0,
    canMoveSelectedTrackDown:
      selectedTrackIndex >= 0 &&
      selectedTrackIndex < (s.project?.tracks.length ?? 0) - 1,
    hasInspectorSelection: selection != null,
    following: s.followingClientId != null,
    recordPanelOpen: s.recordPanelOpen,
    tightenPanelOpen: s.activeTab === "tighten",
  };
}

function evaluateTrackInspectorSelection(
  ctx: CommandContext,
): { ok: true } | { ok: false; reason: string } {
  if (!ctx.hasProject) {
    return { ok: false, reason: "No project loaded" };
  }
  if (!ctx.canIngestMedia) {
    return { ok: false, reason: "Media ingest not allowed" };
  }
  return ctx.trackInspectorSelected
    ? { ok: true }
    : { ok: false, reason: "No track selected in inspector" };
}

export function evaluateWhen(
  when: ContextPredicateId,
  ctx: CommandContext,
): { ok: true } | { ok: false; reason: string } {
  switch (when) {
    case "always":
      return { ok: true };
    case "layoutFocused":
      return ctx.layoutFocused
        ? { ok: true }
        : { ok: false, reason: "Timeline or transcript not focused" };
    case "timelineFocused":
      return ctx.timelineFocused
        ? { ok: true }
        : { ok: false, reason: "Timeline not focused" };
    case "commentMode":
      return ctx.commentMode
        ? { ok: true }
        : { ok: false, reason: "Not in comment mode" };
    case "canSuggestStructural":
      return ctx.canSuggestStructural
        ? { ok: true }
        : { ok: false, reason: "Structural edits not allowed" };
    case "timelineAndStructural":
      if (!ctx.timelineFocused) {
        return { ok: false, reason: "Timeline not focused" };
      }
      if (!ctx.canSuggestStructural) {
        return { ok: false, reason: "Structural edits not allowed" };
      }
      return { ok: true };
    case "hasProject":
      return ctx.hasProject
        ? { ok: true }
        : { ok: false, reason: "No project loaded" };
    case "canApplyPass12":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canApplyPass12
        ? { ok: true }
        : { ok: false, reason: "Pass 1–2 edits not allowed" };
    case "canRefreshMix":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canRefreshMix
        ? { ok: true }
        : { ok: false, reason: "Refresh mix not allowed" };
    case "canIngestMedia":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canIngestMedia
        ? { ok: true }
        : { ok: false, reason: "Media ingest not allowed" };
    case "canManageProjects":
      return ctx.canManageProjects && !isShareProjectKey(ctx.projectPath)
        ? { ok: true }
        : { ok: false, reason: "Project create/open is host-only" };
    case "trackInspectorSelected":
      return evaluateTrackInspectorSelection(ctx);
    case "canMoveSelectedTrackUp":
      {
        const trackGate = evaluateTrackInspectorSelection(ctx);
        if (!trackGate.ok) {
          return trackGate;
        }
      }
      return ctx.canMoveSelectedTrackUp
        ? { ok: true }
        : { ok: false, reason: "Already at top" };
    case "canMoveSelectedTrackDown":
      {
        const trackGate = evaluateTrackInspectorSelection(ctx);
        if (!trackGate.ok) {
          return trackGate;
        }
      }
      return ctx.canMoveSelectedTrackDown
        ? { ok: true }
        : { ok: false, reason: "Already at bottom" };
    case "hasInspectorSelection":
      if (ctx.commentMode) {
        return { ok: false, reason: "Comment mode owns Escape" };
      }
      return ctx.hasInspectorSelection
        ? { ok: true }
        : { ok: false, reason: "Nothing selected" };
    case "following":
      return ctx.following
        ? { ok: true }
        : { ok: false, reason: "Not following" };
    case "recordPanelOpen":
      return ctx.recordPanelOpen
        ? { ok: true }
        : { ok: false, reason: "Record panel is closed" };
    case "tightenPanelOpen":
      return ctx.tightenPanelOpen
        ? { ok: true }
        : { ok: false, reason: "Tighten panel is not open" };
    default:
      return { ok: false, reason: `Unknown when: ${String(when)}` };
  }
}
