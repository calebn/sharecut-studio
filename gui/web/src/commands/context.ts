import { hasDocumentDrafts } from "../document/pendingDrafts";
import {
  canApplyPass12,
  canComment,
  canEditEnvelopes,
  canEditMix,
  canIngestMedia,
  canManageProjects,
  canRefreshMix,
  canSuggestStructural,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { documentActivityBusy } from "../state/documentSendOrder";
import { splitSpeakersBlocker } from "../utils/speakerSplit";
import { focusedClipHandleKind } from "./focusedClipHandle";
import type { ContextPredicateId } from "./types";

export type CommandContext = {
  focusedFadeHandle: boolean;
  focusedTrimHandle: boolean;
  timelineFocused: boolean;
  transcriptFocused: boolean;
  editorFocused: boolean;
  commentMode: boolean;
  canSuggestStructural: boolean;
  canApplyPass12: boolean;
  canRefreshMix: boolean;
  canIngestMedia: boolean;
  /** Host or Editor: may change the saved mix (volume, mute). */
  canEditMix: boolean;
  /** Host or Editor: may change volume envelopes. */
  canEditEnvelopes: boolean;
  /** Host or a guest with the comment capability: may add comments. */
  canComment: boolean;
  canManageProjects: boolean;
  hasProject: boolean;
  canUndo: boolean;
  canRedo: boolean;
  shellBreakpoint: string;
  playheadSec: number;
  timelineDurationSec: number;
  projectPath: string;
  guestMode: string | null;
  /** Inspector selection is a track (header clicked). */
  trackInspectorSelected: boolean;
  /** Inspector-selected track has a lane above it. */
  canMoveSelectedTrackUp: boolean;
  /** Inspector-selected track has a lane below it. */
  canMoveSelectedTrackDown: boolean;
  /** Why the inspector-selected track cannot be split by speaker; null when it can. */
  splitSpeakersBlocker: string | null;
  /** Any inspector selection (clip, track, comment, …). */
  hasInspectorSelection: boolean;
  following: boolean;
  recordPanelOpen: boolean;
  tightenPanelOpen: boolean;
};

function editUnsaved(projectPath: string): boolean {
  return documentActivityBusy(projectPath) || hasDocumentDrafts();
}

export function buildCommandContext(): CommandContext {
  const s = useDawStore.getState();
  const transcriptFocused =
    s.stage === "edit" &&
    (s.shellBreakpoint === "phone"
      ? s.editSurface === "text"
      : !s.scriptCollapsed);
  const selection = s.selection;
  const selectedTrackIndex =
    selection?.kind === "track"
      ? (s.project?.tracks.findIndex(
          (track) => track.id === selection.trackId,
        ) ?? -1)
      : -1;
  return {
    focusedFadeHandle: focusedClipHandleKind() === "fade",
    focusedTrimHandle: focusedClipHandleKind() === "trim",
    timelineFocused: s.timelineFocused,
    transcriptFocused,
    editorFocused: s.timelineFocused || transcriptFocused,
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
    canEditMix: canEditMix(s.projectPath, s.guestMode, s.shareCapabilities),
    canEditEnvelopes: canEditEnvelopes(
      s.projectPath,
      s.guestMode,
      s.shareCapabilities,
    ),
    canComment: canComment(s.projectPath, s.guestMode, s.shareCapabilities),
    canManageProjects: canManageProjects(s.projectPath),
    hasProject: s.project != null,
    canUndo:
      s.guestMode != null ||
      (s.project?.history?.can_undo ?? false) ||
      editUnsaved(s.projectPath),
    canRedo: s.guestMode != null || (s.project?.history?.can_redo ?? false),
    shellBreakpoint: s.shellBreakpoint,
    playheadSec: s.playheadSec,
    timelineDurationSec: s.project?.timeline_duration_sec ?? Infinity,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    trackInspectorSelected: selection?.kind === "track",
    canMoveSelectedTrackUp: selectedTrackIndex > 0,
    canMoveSelectedTrackDown:
      selectedTrackIndex >= 0 &&
      selectedTrackIndex < (s.project?.tracks.length ?? 0) - 1,
    splitSpeakersBlocker: splitSpeakersBlocker(
      selection?.kind === "track"
        ? s.project?.tracks.find((track) => track.id === selection.trackId)
        : undefined,
      canManageProjects(s.projectPath),
    ),
    hasInspectorSelection: selection != null,
    following: s.followingClientId != null,
    recordPanelOpen: s.chrome.recordPanelOpen,
    tightenPanelOpen: s.stage === "review" && s.reviewSection === "tighten",
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
    case "focusedFadeHandle":
      return ctx.focusedFadeHandle
        ? { ok: true }
        : { ok: false, reason: "No fade handle focused" };
    case "focusedTrimHandle":
      return ctx.focusedTrimHandle
        ? { ok: true }
        : { ok: false, reason: "No trim handle focused" };
    case "always":
      return { ok: true };
    case "layoutShell":
      return ctx.shellBreakpoint !== "phone"
        ? { ok: true }
        : { ok: false, reason: "Layouts need the desktop or tablet shell" };
    case "editorFocused":
      return ctx.editorFocused
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
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canSuggestStructural
        ? { ok: true }
        : { ok: false, reason: "Structural edits not allowed" };
    case "timelineAndStructural":
      if (!ctx.timelineFocused) {
        return { ok: false, reason: "Timeline not focused" };
      }
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      if (!ctx.canSuggestStructural) {
        return { ok: false, reason: "Structural edits not allowed" };
      }
      return { ok: true };
    case "canUndo":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canUndo
        ? { ok: true }
        : { ok: false, reason: "Nothing to undo" };
    case "canRedo":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canRedo
        ? { ok: true }
        : { ok: false, reason: "Nothing to redo" };
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
    case "canEditMix":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canEditMix
        ? { ok: true }
        : { ok: false, reason: "Only the host and editors can change the mix" };
    case "canEditEnvelopes":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canEditEnvelopes
        ? { ok: true }
        : {
            ok: false,
            reason: "Only the host and editors can change envelopes",
          };
    case "canComment":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.canComment
        ? { ok: true }
        : { ok: false, reason: "This link cannot add comments" };
    case "canManageProjects":
      return ctx.canManageProjects
        ? { ok: true }
        : { ok: false, reason: "Project create/open is host-only" };
    case "hostProjectLoaded":
      if (!ctx.canManageProjects) {
        return {
          ok: false,
          reason: "Host-only (not available on review links)",
        };
      }
      return ctx.hasProject
        ? { ok: true }
        : { ok: false, reason: "No project loaded" };
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
    case "canSplitSpeakers":
      if (!ctx.hasProject) {
        return { ok: false, reason: "No project loaded" };
      }
      return ctx.splitSpeakersBlocker == null
        ? { ok: true }
        : { ok: false, reason: ctx.splitSpeakersBlocker };
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
