import {
  deleteClips,
  duplicateSegment,
  followExportJob,
  hostLandRecord,
  pasteSegment,
  patchComment,
  redoHistory,
  refreshProject,
  rippleDeleteClips,
  rippleDeleteRange,
  splitAtTime,
  startExportJob,
  startRenderPreview,
  undoHistory,
  waitForPipelineJob,
} from "../api";
import { desktopCloseGuardArmed } from "../desktop/useDesktopCloseGuard";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { patchClipsMove, patchTracksOrder } from "../document/projectPatch";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { payloadFromSelection } from "../edit/selectionClipboard";
import {
  FEATURE_SHARE_UI_MENU,
  hasFeature,
  peekCachedFeatures,
} from "../extensions/features";
import { useRecordHostStore } from "../record/hostStore";
import { submitHostRecordTransport } from "../record/hostTransport";
import { sendRecordHostCommand } from "../record/hostWire";
import {
  HOST_COMMENT_QUEUE_TOKEN,
  liveTakeOpen,
  MARKER_BODY,
  postLiveComment,
} from "../record/liveCommentQueue";
import {
  canApplyPass12,
  canIngestMedia,
  canManageProjects,
  canRefreshMix,
  canSuggestStructuralOnProject,
  guestHearsMixOnly,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { seedStudioJob } from "../state/seedStudioJob";
import type {
  AuditionMode,
  DawTab,
  FocusMode,
  MobileMode,
  MoreDestination,
} from "../state/types";
import { errorMessage } from "../utils/apiError";
import { bladeTrackIds } from "../utils/bladeTracks";
import { discreteZoomFactor } from "../utils/zoom";
import { type CommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import { resolveTrackId } from "./targets";
import { registerTightenCommands } from "./tighten";
import { flushPendingMix, registerTrackMixCommands } from "./trackMix";
import type { ExecuteResult } from "./types";

const PROJECT_SWITCH_BLOCKED =
  "Stop and finish recording before switching projects";

type BladeRunner = {
  requestCut: (atTime: number) => void | Promise<void>;
  confirmPending: () => void | Promise<void>;
  cancelPending: () => void;
};

let bladeRunner: BladeRunner | null = null;
let projectOpenInFlight = false;
let exportDeliverablesInFlight = false;
let trackMutateChain: Promise<void> = Promise.resolve();

export function _resetProjectOpenInFlightForTests(): void {
  projectOpenInFlight = false;
}

export function _resetExportDeliverablesInFlightForTests(): void {
  exportDeliverablesInFlight = false;
}

export function _resetTrackMutateChainForTests(): void {
  trackMutateChain = Promise.resolve();
}

function enqueueTrackMutate<T>(fn: () => Promise<T>): Promise<T> {
  const run = trackMutateChain.then(fn, fn);
  trackMutateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function resolveInspectorTrackId(args: Record<string, unknown>): string | null {
  if (typeof args.trackId === "string" && args.trackId) {
    return args.trackId;
  }
  const s = useDawStore.getState();
  return s.selection?.kind === "track" ? s.selection.trackId : null;
}

function formatAmp(amp: number): string {
  const rounded = Math.round(amp * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

async function applyTrackReorder(
  trackId: string,
  index: number,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
    return { status: "disabled", reason: "Media ingest not allowed" };
  }
  if (!Number.isFinite(index) || !Number.isInteger(index)) {
    return { status: "disabled", reason: "index must be an integer" };
  }
  if (!s.project?.tracks.some((t) => t.id === trackId)) {
    return { status: "disabled", reason: "Unknown track" };
  }
  const previous = s.project;
  const seqAtStart = currentDocumentSeq();
  s.setProject(patchTracksOrder(previous, trackId, index));
  try {
    const { reorderTrackCommand } = await import("../api");
    await reorderTrackCommand(s.projectPath, trackId, index);
    useDawStore.getState().announceStatus("Reordered track");
    return { status: "ok" };
  } catch (e) {
    revertOptimisticIfUnchanged(previous, seqAtStart);
    const msg = errorMessage(e);
    useDawStore.getState().announceStatus(`Reorder failed: ${msg}`);
    return { status: "disabled", reason: msg };
  }
}

/** Injected from useBladeCut so execute stays hook-free. */
export function setBladeCommandRunner(runner: BladeRunner | null): void {
  bladeRunner = runner;
}

type DawState = ReturnType<typeof useDawStore.getState>;

function canSuggestStructuralFor(s: DawState): boolean {
  return canSuggestStructuralOnProject(
    s.projectPath,
    s.guestMode,
    s.shareCapabilities,
    s.project != null,
  );
}

/** Same rule and reason as the `hostProjectLoaded` when-clause (handlers run with skipWhen). */
function hostProjectGate(ctx: CommandContext): ExecuteResult | null {
  const gate = evaluateWhen("hostProjectLoaded", ctx);
  return gate.ok ? null : { status: "disabled", reason: gate.reason };
}

async function runSplitAt(
  _ctx: CommandContext,
  atTime: number,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!s.project || !canSuggestStructuralFor(s)) {
    return { status: "disabled", reason: "Structural edits not allowed" };
  }
  const dialogueIds = (s.project.tracks ?? [])
    .filter((t) => t.role === "dialogue")
    .map((t) => t.id);
  const tids = bladeTrackIds(s.selectedTrackIds, dialogueIds);
  await splitAtTime(s.projectPath, atTime, tids);
  s.setBladeConfirmSec(null);
  return { status: "ok" };
}

function resolveClipId(args: Record<string, unknown>): string | null {
  if (typeof args.clipId === "string" && args.clipId) {
    return args.clipId;
  }
  const s = useDawStore.getState();
  if (s.selection?.kind === "clip") {
    return s.selection.id;
  }
  return null;
}

async function runDeleteClip(
  clipId: string,
  ripple: boolean,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canSuggestStructuralFor(s)) {
    return { status: "disabled", reason: "Structural edits not allowed" };
  }
  try {
    if (ripple) {
      await rippleDeleteClips(s.projectPath, [clipId]);
    } else {
      await deleteClips(s.projectPath, [clipId]);
    }
    const store = useDawStore.getState();
    store.setSelection(null);
    store.announceStatus(ripple ? "Ripple deleted clip" : "Deleted clip");
    return { status: "ok" };
  } catch (e) {
    const msg = errorMessage(e);
    useDawStore.getState().announceStatus(`Delete failed: ${msg}`);
    return { status: "disabled", reason: msg };
  }
}

export function registerDawCommands(): void {
  registerCommand("transport.togglePlay", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "Project not loaded" };
    }
    s.togglePlaying();
    return { status: "ok" };
  });

  registerCommand("transport.stop", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "Project not loaded" };
    }
    s.setIsPlaying(false);
    return { status: "ok" };
  });

  registerCommand("transport.seek", (args) => {
    const sec = Number(args.sec);
    if (!Number.isFinite(sec)) {
      return { status: "disabled", reason: "sec must be a number" };
    }
    const s = useDawStore.getState();
    const duration = s.project?.timeline_duration_sec ?? Infinity;
    s.setPlayheadSec(Math.max(0, Math.min(duration, sec)));
    return { status: "ok" };
  });

  const AUDITION = new Set(["mix", "fx", "raw"]);
  registerCommand("transport.audition", (args) => {
    const mode = args.mode;
    if (typeof mode !== "string" || !AUDITION.has(mode)) {
      return { status: "disabled", reason: "mode required" };
    }
    if (guestHearsMixOnly(useDawStore.getState().guestMode) && mode !== "mix") {
      return { status: "disabled", reason: "guests hear Mix only" };
    }
    useDawStore.getState().setAuditionMode(mode as AuditionMode);
    return { status: "ok" };
  });

  registerCommand("presence.follow", (args) => {
    const clientId = typeof args.clientId === "string" ? args.clientId : "";
    if (!clientId) {
      return { status: "disabled", reason: "clientId required" };
    }
    const s = useDawStore.getState();
    if (s.followingClientId === clientId) {
      s.stopFollow("local");
      return { status: "ok" };
    }
    s.startFollow(clientId);
    return { status: "ok" };
  });

  registerCommand("presence.unfollow", () => {
    useDawStore.getState().stopFollow("local");
    return { status: "ok" };
  });

  registerCommand("tool.select", () => {
    useDawStore.getState().setToolMode("select");
    return { status: "ok" };
  });

  registerCommand("tool.blade", () => {
    useDawStore.getState().setToolMode("blade");
    return { status: "ok" };
  });

  registerCommand("review.exitCommentMode", () => {
    useDawStore.getState().setCommentMode(false);
    return { status: "ok" };
  });

  registerCommand("review.toggleCommentMode", () => {
    useDawStore.getState().toggleCommentMode();
    return { status: "ok" };
  });

  registerCommand("comment.resolve", async (args) => {
    const s = useDawStore.getState();
    if (
      !s.project ||
      s.guestMode != null ||
      !canManageProjects(s.projectPath)
    ) {
      return { status: "disabled", reason: "Comment resolve is host-only" };
    }
    const { commentId, resolved, by } = args;
    if (
      typeof commentId !== "string" ||
      !commentId ||
      typeof resolved !== "boolean" ||
      typeof by !== "string" ||
      !by.trim()
    ) {
      return {
        status: "disabled",
        reason: "Invalid comment resolve arguments",
      };
    }
    const comment = s.project.comments?.find((c) => c.id === commentId);
    if (!comment) {
      return { status: "disabled", reason: "Unknown comment" };
    }
    if (resolved && comment.resolved) {
      return { status: "disabled", reason: "Comment is already resolved" };
    }
    try {
      await patchComment(s.projectPath, commentId, { resolved, by });
      return { status: "ok" };
    } catch (e) {
      return { status: "disabled", reason: errorMessage(e) };
    }
  });

  const setFocus = (mode: FocusMode) => {
    useDawStore.getState().setFocusMode(mode);
    return { status: "ok" } as const;
  };

  registerCommand("focus.default", () => setFocus("default"));
  registerCommand("focus.timeline", () => setFocus("timeline"));
  registerCommand("focus.text", () => setFocus("text"));
  registerCommand("focus.review", () => setFocus("review"));
  registerCommand("focus.cycle", () => {
    useDawStore.getState().cycleFocusMode();
    return { status: "ok" };
  });

  registerCommand("navigation.nudgePlayheadBack", (args, ctx) => {
    const delta = args.shift ? 5 : 1;
    const s = useDawStore.getState();
    s.setPlayheadSec(Math.max(0, ctx.playheadSec - delta));
    return { status: "ok" };
  });

  registerCommand("navigation.nudgePlayheadForward", (args, ctx) => {
    const delta = args.shift ? 5 : 1;
    const s = useDawStore.getState();
    s.setPlayheadSec(
      Math.min(ctx.timelineDurationSec, ctx.playheadSec + delta),
    );
    return { status: "ok" };
  });

  registerCommand("navigation.goToStart", () => {
    const s = useDawStore.getState();
    s.setPlayheadSec(0);
    return { status: "ok" };
  });

  registerCommand("navigation.goToEnd", (_args, ctx) => {
    const end = Number.isFinite(ctx.timelineDurationSec)
      ? ctx.timelineDurationSec
      : 0;
    const s = useDawStore.getState();
    s.setPlayheadSec(Math.max(0, end));
    return { status: "ok" };
  });

  registerCommand("edit.bladeCut", async (args, ctx) => {
    const raw = args.atTime;
    const atTime =
      raw === undefined || raw === null ? ctx.playheadSec : Number(raw);
    if (!Number.isFinite(atTime)) {
      return { status: "disabled", reason: "atTime must be a number" };
    }
    if (bladeRunner) {
      await bladeRunner.requestCut(atTime);
      return { status: "ok" };
    }
    const s = useDawStore.getState();
    if (s.shellBreakpoint === "phone" || s.shellBreakpoint === "tablet") {
      s.setBladeConfirmSec(atTime);
      return { status: "ok" };
    }
    return runSplitAt(ctx, atTime);
  });

  registerCommand("edit.bladeCut.confirm", async (_args, ctx) => {
    if (bladeRunner) {
      await bladeRunner.confirmPending();
      return { status: "ok" };
    }
    if (ctx.bladeConfirmSec == null) {
      return { status: "disabled", reason: "No pending blade cut" };
    }
    return runSplitAt(ctx, ctx.bladeConfirmSec);
  });

  registerCommand("edit.bladeCut.cancel", () => {
    if (bladeRunner) {
      bladeRunner.cancelPending();
      return { status: "ok" };
    }
    useDawStore.getState().setBladeConfirmSec(null);
    return { status: "ok" };
  });

  registerCommand("edit.delete", async (args) => {
    const clipId = resolveClipId(args);
    if (!clipId) {
      return { status: "disabled", reason: "No clip selected" };
    }
    return runDeleteClip(clipId, false);
  });

  registerCommand("edit.clearSelection", () => {
    useDawStore.getState().setSelection(null);
    return { status: "ok" };
  });

  registerCommand("edit.rippleDelete", async (args) => {
    const clipId = resolveClipId(args);
    if (!clipId) {
      return { status: "disabled", reason: "No clip selected" };
    }
    return runDeleteClip(clipId, true);
  });

  registerCommand("track.selectAll", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.setSelectedTrackIds(s.project.tracks.map((t) => t.id));
    return { status: "ok" };
  });

  registerCommand("track.deselectAll", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.setSelectedTrackIds([]);
    if (s.selection?.kind === "track") {
      s.setSelection(null);
    }
    return { status: "ok" };
  });

  registerCommand("track.soloToggle", (args) => {
    const trackId = resolveTrackId(args);
    if (!trackId) {
      return { status: "disabled", reason: "No track selected" };
    }
    useDawStore.getState().toggleSolo(trackId);
    return { status: "ok" };
  });

  registerCommand("view.zoomIn", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.applyAnchoredZoom(s.zoomPxPerSec * discreteZoomFactor("in"));
    return { status: "ok" };
  });

  registerCommand("view.zoomOut", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.applyAnchoredZoom(s.zoomPxPerSec * discreteZoomFactor("out"));
    return { status: "ok" };
  });

  registerCommand("view.fit", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.fitToWindow(s.measureTimelineViewport());
    return { status: "ok" };
  });

  const TABS = new Set<DawTab>([
    "transcript",
    "history",
    "impact",
    "tighten",
    "pipeline",
    "comments",
  ]);
  registerCommand("view.setTab", (args) => {
    const tab = args.tab;
    if (typeof tab !== "string" || !TABS.has(tab as DawTab)) {
      return { status: "disabled", reason: "tab required" };
    }
    useDawStore.getState().setActiveTab(tab as DawTab);
    return { status: "ok" };
  });

  const MODES = new Set<MobileMode>(["listen", "timeline", "text", "more"]);
  const DESTINATIONS = new Set<MoreDestination>([
    "hub",
    "comments",
    "history",
    "impact",
    "tighten",
    "pipeline",
  ]);
  registerCommand("view.setMobileMode", (args) => {
    const mode = args.mode;
    if (typeof mode !== "string" || !MODES.has(mode as MobileMode)) {
      return { status: "disabled", reason: "mode required" };
    }
    const dest = args.destination;
    if (typeof dest === "string") {
      if (!DESTINATIONS.has(dest as MoreDestination)) {
        return { status: "disabled", reason: "destination unknown" };
      }
      useDawStore.getState().setMoreDestination(dest as MoreDestination);
    } else {
      useDawStore.getState().setMobileMode(mode as MobileMode);
    }
    return { status: "ok" };
  });

  registerCommand("view.waveformZoomIn", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.nudgeWaveformAmp("in");
    const amp = useDawStore.getState().waveformAmpZoom;
    s.announceStatus(`Waveform amplitude ×${formatAmp(amp)}`);
    return { status: "ok" };
  });

  registerCommand("view.waveformZoomOut", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.nudgeWaveformAmp("out");
    const amp = useDawStore.getState().waveformAmpZoom;
    s.announceStatus(`Waveform amplitude ×${formatAmp(amp)}`);
    return { status: "ok" };
  });

  // A volume still in its save delay goes first, so undo takes it back
  // instead of the step before it.
  registerCommand("history.undo", async (_args, ctx) => {
    await flushPendingMix();
    await undoHistory(ctx.projectPath);
    return { status: "ok" };
  });

  registerCommand("history.redo", async (_args, ctx) => {
    await flushPendingMix();
    await redoHistory(ctx.projectPath);
    return { status: "ok" };
  });

  registerCommand("edit.copy", (_args) => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    const payload = payloadFromSelection(s.project, s.selection, "copy");
    if (!payload) {
      return { status: "disabled", reason: "Nothing to copy" };
    }
    setClipboard(payload);
    if (payload.plainText && typeof navigator !== "undefined") {
      void navigator.clipboard?.writeText?.(payload.plainText).catch(() => {});
    }
    s.announceStatus(
      `Copied ${(payload.timelineEnd - payload.timelineStart).toFixed(2)}s`,
    );
    return { status: "ok" };
  });

  registerCommand("edit.cut", async (_args) => {
    const s = useDawStore.getState();
    if (
      !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) ||
      !s.project
    ) {
      return { status: "disabled", reason: "Cut not allowed" };
    }
    if (s.selection?.kind === "transcriptWord") {
      return {
        status: "disabled",
        reason: "Use Select mode for media cut (Correct is ASR-only)",
      };
    }
    const payload = payloadFromSelection(s.project, s.selection, "cut");
    if (!payload) {
      return { status: "disabled", reason: "Nothing to cut" };
    }
    setClipboard(payload);
    if (payload.plainText && typeof navigator !== "undefined") {
      void navigator.clipboard?.writeText?.(payload.plainText).catch(() => {});
    }
    try {
      if (s.selection?.kind === "clip") {
        await rippleDeleteClips(s.projectPath, [s.selection.id]);
      } else {
        await rippleDeleteRange(
          s.projectPath,
          payload.timelineStart,
          payload.timelineEnd,
        );
      }
      const store = useDawStore.getState();
      store.setSelection(null);
      store.announceStatus("Cut to clipboard");
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore.getState().announceStatus(`Cut failed: ${msg}`);
      return { status: "disabled", reason: msg };
    }
  });

  registerCommand("edit.paste", async (_args) => {
    const s = useDawStore.getState();
    if (
      !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) ||
      !s.project
    ) {
      return { status: "disabled", reason: "Paste not allowed" };
    }
    const clip = getClipboard();
    if (!clip) {
      return { status: "disabled", reason: "Clipboard empty" };
    }
    const duration = clip.timelineEnd - clip.timelineStart;
    try {
      if (clip.mode === "cut" || clip.extracts.length > 0) {
        await pasteSegment(
          s.projectPath,
          s.playheadSec,
          duration,
          clip.extracts as unknown as Array<Record<string, unknown>>,
        );
      } else {
        await duplicateSegment(
          s.projectPath,
          clip.timelineStart,
          clip.timelineEnd,
          s.playheadSec,
        );
      }
      useDawStore.getState().announceStatus("Pasted at playhead (same track)");
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore.getState().announceStatus(`Paste failed: ${msg}`);
      return { status: "disabled", reason: msg };
    }
  });

  registerCommand("ui.toggleCommandPalette", () => {
    useDawStore.getState().toggleCommandPalette();
    return { status: "ok" };
  });

  registerCommand("render.refreshMix", async () => {
    const s = useDawStore.getState();
    if (
      !canRefreshMix(s.projectPath, s.guestMode, s.shareCapabilities) ||
      !s.project
    ) {
      return { status: "disabled", reason: "Refresh mix not allowed" };
    }
    if (s.renderPreviewBusy) {
      return { status: "disabled", reason: "Refresh already running" };
    }
    const projectEpoch = s.projectEpoch;
    const isCurrentProject = () =>
      useDawStore.getState().projectEpoch === projectEpoch;
    s.setRenderPreviewBusy(true);
    s.announceStatus("Refreshing mix preview…");
    try {
      const started = await startRenderPreview(s.projectPath);
      if (!isCurrentProject()) {
        return { status: "disabled", reason: "Project changed during refresh" };
      }
      if (started.mode === "job") {
        seedStudioJob(started.job);
        const done = await waitForPipelineJob(started.job.id);
        if (done.status === "error") {
          const reason = done.error ?? "Render preview failed";
          if (isCurrentProject()) {
            useDawStore.getState().announceStatus(`Refresh failed: ${reason}`);
          }
          return {
            status: "disabled",
            reason,
          };
        }
      } else if (!started.ok) {
        const reason = "Render preview failed";
        if (isCurrentProject()) {
          useDawStore.getState().announceStatus(`Refresh failed: ${reason}`);
        }
        return { status: "disabled", reason };
      }
      if (!isCurrentProject()) {
        return { status: "disabled", reason: "Project changed during refresh" };
      }
      const project = await refreshProject(s.projectPath);
      if (!isCurrentProject()) {
        return { status: "disabled", reason: "Project changed during refresh" };
      }
      applyDocumentSnapshot({ project }, { force: true });
      const store = useDawStore.getState();
      store.setHighlightStaleRender(false);
      store.announceStatus("Mix preview refreshed");
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      if (isCurrentProject()) {
        useDawStore.getState().announceStatus(`Refresh failed: ${reason}`);
      }
      return {
        status: "disabled",
        reason,
      };
    } finally {
      if (isCurrentProject()) {
        useDawStore.getState().setRenderPreviewBusy(false);
        useDawStore.getState().setHighlightStaleRender(false);
      }
    }
  });

  registerCommand("export.bounce", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    useDawStore.getState().setBounceDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("mcp.connect", () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return { status: "disabled", reason: "Connect agent is host-only" };
    }
    s.setHostMcpDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("help.diagnosticsBundle", () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return { status: "disabled", reason: "Help is host-only" };
    }
    s.setHelpDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("share.manage", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    const s = useDawStore.getState();
    const features = peekCachedFeatures();
    if (features !== null && !hasFeature(features, FEATURE_SHARE_UI_MENU)) {
      return {
        status: "disabled",
        reason: "Share requires the online extension",
      };
    }
    s.setShareDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("record.openPanel", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    useDawStore.getState().setRecordPanelOpen(true);
    return { status: "ok" };
  });

  registerCommand("record.start", async () => {
    try {
      await submitHostRecordTransport("Start");
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      useDawStore.getState().announceStatus(reason);
      return { status: "disabled", reason };
    }
  });
  registerCommand("record.pause", async () => {
    try {
      await submitHostRecordTransport("Pause");
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      useDawStore.getState().announceStatus(reason);
      return { status: "disabled", reason };
    }
  });
  registerCommand("record.resume", async () => {
    try {
      await submitHostRecordTransport("Resume");
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      useDawStore.getState().announceStatus(reason);
      return { status: "disabled", reason };
    }
  });
  registerCommand("record.stop", async () => {
    try {
      await submitHostRecordTransport("Stop");
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      useDawStore.getState().announceStatus(reason);
      return { status: "disabled", reason };
    }
  });
  registerCommand("record.land", async () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return { status: "disabled", reason: "Landing keepers is host-only" };
    }
    try {
      const result = await hostLandRecord(s.projectPath);
      const n = Array.isArray(result.clips) ? result.clips.length : 0;
      const project = await refreshProject(s.projectPath);
      applyDocumentSnapshot({ project }, { force: true });
      useDawStore
        .getState()
        .announceStatus(`Landed ${n} clip(s) on the timeline`);
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      useDawStore.getState().announceStatus(reason);
      return { status: "disabled", reason };
    }
  });

  registerCommand("record.marker", () => {
    const snap = useRecordHostStore.getState().snapshot;
    if (!snap || !liveTakeOpen(snap.state)) {
      return { status: "disabled", reason: "Record a take to drop a marker" };
    }
    postLiveComment(sendRecordHostCommand, HOST_COMMENT_QUEUE_TOKEN, {
      body: MARKER_BODY,
      takeIndex: snap.take_index,
      recordingMs: snap.recording_ms ?? 0,
      author: "p_host",
    });
    useDawStore.getState().announceStatus("Marker");
    return { status: "ok" };
  });

  registerCommand("export.deliverables", async (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    const s = useDawStore.getState();
    if (exportDeliverablesInFlight) {
      s.announceStatus("Export already in progress…");
      return { status: "disabled", reason: "Export already running" };
    }
    exportDeliverablesInFlight = true;
    s.announceStatus("Exporting deliverables…");
    try {
      const job = await startExportJob(s.projectPath);
      seedStudioJob(job);
      const paths = await followExportJob(job.id, "Export failed");
      s.announceStatus(`Exported ${paths.length} file(s) to export/`);
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      useDawStore.getState().announceStatus(`Export failed: ${reason}`);
      return { status: "disabled", reason };
    } finally {
      exportDeliverablesInFlight = false;
    }
  });

  registerCommand("project.new", () => {
    if (desktopCloseGuardArmed()) {
      useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
      return { status: "disabled", reason: PROJECT_SWITCH_BLOCKED };
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("project");
    window.location.assign(url.toString());
    return { status: "ok" };
  });

  registerCommand("project.open", () => {
    if (desktopCloseGuardArmed()) {
      useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
      return { status: "disabled", reason: PROJECT_SWITCH_BLOCKED };
    }
    if (projectOpenInFlight) {
      return { status: "ok" };
    }
    projectOpenInFlight = true;
    void (async () => {
      try {
        const { openEpisodeProject, pickEpisodeProject } = await import(
          "../api"
        );
        let path: string | null = null;
        try {
          const picked = await pickEpisodeProject();
          if ("cancelled" in picked && picked.cancelled) {
            if (picked.detail) {
              useDawStore.getState().announceStatus(picked.detail);
            }
            return;
          }
          if ("unavailable" in picked && picked.unavailable) {
            path = window.prompt(
              picked.detail || "Path to episode.project.json",
            );
          } else if ("project_path" in picked) {
            path = picked.project_path;
          }
        } catch (err) {
          const reason = errorMessage(err);
          useDawStore.getState().announceStatus(`Open failed: ${reason}`);
          return;
        }
        if (!path?.trim()) {
          return;
        }
        if (desktopCloseGuardArmed()) {
          useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
          return;
        }
        try {
          const out = await openEpisodeProject(path.trim());
          if (desktopCloseGuardArmed()) {
            useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
            return;
          }
          const url = new URL(window.location.href);
          url.searchParams.set("project", out.project_path);
          window.location.assign(url.toString());
        } catch (err) {
          const reason = errorMessage(err);
          useDawStore.getState().announceStatus(`Open failed: ${reason}`);
        }
      } finally {
        projectOpenInFlight = false;
      }
    })();
    return { status: "ok" };
  });

  registerCommand("track.add", async () => {
    const s = useDawStore.getState();
    if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Media ingest not allowed" };
    }
    const { addTrackCommand } = await import("../api");
    await addTrackCommand(s.projectPath, {});
    return { status: "ok" };
  });

  registerCommand("track.remove", async (args) => {
    return enqueueTrackMutate(async () => {
      const s = useDawStore.getState();
      if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
        return { status: "disabled", reason: "Media ingest not allowed" };
      }
      const trackId = resolveInspectorTrackId(args);
      if (!trackId) {
        return { status: "disabled", reason: "No track selected in inspector" };
      }
      const track = s.project?.tracks.find((t) => t.id === trackId);
      const label = track?.label || trackId;
      if (!window.confirm(`Remove track ${label}?`)) {
        return { status: "disabled", reason: "Cancelled" };
      }
      try {
        const { removeTrackCommand } = await import("../api");
        await removeTrackCommand(s.projectPath, trackId);
        useDawStore.getState().announceStatus(`Removed ${label}`);
        const next = useDawStore.getState();
        next.setSelectedTrackIds(
          next.selectedTrackIds.filter((id) => id !== trackId),
        );
        next.setSelection(null);
        return { status: "ok" };
      } catch (e) {
        const msg = errorMessage(e);
        useDawStore.getState().announceStatus(`Remove failed: ${msg}`);
        return { status: "disabled", reason: msg };
      }
    });
  });

  registerCommand("track.reorder", async (args) => {
    return enqueueTrackMutate(async () => {
      const trackId = resolveInspectorTrackId(args);
      if (!trackId) {
        return { status: "disabled", reason: "No track selected in inspector" };
      }
      return applyTrackReorder(trackId, Number(args.index));
    });
  });

  registerCommand("track.moveUp", async (args) => {
    return enqueueTrackMutate(async () => {
      const s = useDawStore.getState();
      const trackId = resolveInspectorTrackId(args);
      if (!trackId || !s.project) {
        return { status: "disabled", reason: "No track selected in inspector" };
      }
      const current = s.project.tracks.findIndex((t) => t.id === trackId);
      if (current <= 0) {
        return { status: "disabled", reason: "Already at top" };
      }
      return applyTrackReorder(trackId, current - 1);
    });
  });

  registerCommand("track.moveDown", async (args) => {
    return enqueueTrackMutate(async () => {
      const s = useDawStore.getState();
      const trackId = resolveInspectorTrackId(args);
      if (!trackId || !s.project) {
        return { status: "disabled", reason: "No track selected in inspector" };
      }
      const current = s.project.tracks.findIndex((t) => t.id === trackId);
      if (current < 0 || current >= s.project.tracks.length - 1) {
        return { status: "disabled", reason: "Already at bottom" };
      }
      return applyTrackReorder(trackId, current + 1);
    });
  });

  registerCommand("media.import", async (args) => {
    const s = useDawStore.getState();
    if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Media ingest not allowed" };
    }
    const { ingestFiles, pickAudioFiles } = await import(
      "../ingest/ingestFiles"
    );
    const files = await pickAudioFiles(true);
    if (!files.length) {
      return { status: "disabled", reason: "No files selected" };
    }
    const trackId =
      typeof args.trackId === "string"
        ? args.trackId
        : (s.selectedTrackIds[0] ??
          (s.selection?.kind === "track" ? s.selection.trackId : null));
    await ingestFiles(
      files,
      trackId ? { kind: "track", id: trackId } : { kind: "new" },
    );
    return { status: "ok" };
  });

  registerCommand("view.transcriptAnnotate", () => {
    useDawStore.getState().toggleTranscriptAnnotate();
    return { status: "ok" };
  });

  registerCommand("transcript.correctIntent", () => {
    // Intent is owned by TranscriptPanel; store annotate stays independent.
    return { status: "ok" };
  });

  registerCommand("transcript.selectIntent", () => {
    return { status: "ok" };
  });

  registerCommand("view.showCutAway", () => {
    const s = useDawStore.getState();
    if (!s.transcriptAnnotate) {
      s.setTranscriptAnnotate(true);
    }
    s.toggleShowCutAwayUtterances();
    return { status: "ok" };
  });

  registerCommand("edit.trimClipEdge", () => {
    return {
      status: "disabled",
      reason: "Use the clip trim handles on the timeline",
    };
  });

  registerCommand("edit.rollClipJoin", () => {
    return {
      status: "disabled",
      reason: "Use the join diamond or transcript boundary glyph",
    };
  });

  registerCommand("edit.setClipFade", () => {
    return {
      status: "disabled",
      reason: "Use the clip fade handles on the timeline",
    };
  });

  registerCommand("edit.moveClips", async (args) => {
    return enqueueTrackMutate(async () => {
      const s = useDawStore.getState();
      if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
        return { status: "disabled", reason: "Edits not allowed" };
      }
      if (!s.project) {
        return { status: "disabled", reason: "No project" };
      }
      const raw = args.clips;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { status: "disabled", reason: "clips must be a non-empty list" };
      }
      const clips: Array<{
        clip_id: string;
        timeline_start: number;
        track_id: string;
      }> = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") {
          return {
            status: "disabled",
            reason: "each clip move must be an object",
          };
        }
        const rec = item as Record<string, unknown>;
        if (
          typeof rec.clip_id !== "string" ||
          typeof rec.track_id !== "string" ||
          typeof rec.timeline_start !== "number" ||
          !Number.isFinite(rec.timeline_start)
        ) {
          return { status: "disabled", reason: "invalid clip move" };
        }
        clips.push({
          clip_id: rec.clip_id,
          timeline_start: rec.timeline_start,
          track_id: rec.track_id,
        });
      }
      const previous = s.project;
      const seqAtStart = currentDocumentSeq();
      s.setProject(patchClipsMove(previous, clips));
      const sel = s.selection;
      if (sel?.kind === "clip") {
        const moved = clips.find((c) => c.clip_id === sel.id);
        if (moved) {
          s.setSelection({ ...sel, trackId: moved.track_id });
        }
      }
      try {
        const { moveClips } = await import("../api");
        await moveClips(s.projectPath, clips);
        useDawStore.getState().announceStatus("Moved clips");
        return { status: "ok" };
      } catch (e) {
        revertOptimisticIfUnchanged(previous, seqAtStart);
        const msg = errorMessage(e);
        useDawStore.getState().announceStatus(`Move failed: ${msg}`);
        return { status: "disabled", reason: msg };
      }
    });
  });

  registerCommand("view.focusEditBoundary", () => ({ status: "ok" }));
  registerCommand("view.focusCutAwayWord", () => ({ status: "ok" }));

  registerTightenCommands();
  registerTrackMixCommands();
}
