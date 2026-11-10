import type { StateCreator } from "zustand";
import { cssViewportWidth } from "../hooks/useViewportClass";
import {
  readLaneHeightPref,
  stepLaneHeightPx,
  writeLaneHeightPref,
} from "../utils/laneHeightPref";
import { plainError } from "../utils/plainError";
import { readSnapPref, writeSnapPref } from "../utils/snapPref";
import {
  fixedLineOffsetPx,
  maxLogicalScrollLeft,
  measureTimelineColumns,
  timelineTimeViewportWidth,
  viewportCenterOffsetPx,
} from "../utils/timelineViewport";
import {
  DEFAULT_WAVEFORM_VIEW_PREF,
  writeWaveformViewPref,
} from "../utils/waveformViewPref";
import {
  anchoredZoomScroll,
  clampWaveformAmp,
  clampZoomPxPerSec,
  discreteZoomFactor,
  fitZoomPxPerSec,
  roundWaveformAmp,
  sessionSecOf,
  visiblePlayheadClientX,
} from "../utils/zoom";
import {
  noteZoomPointerClientX,
  peekZoomPointerClientX,
} from "../utils/zoomPointer";
import { joinJobCopy } from "./jobCopy";
import { inspectKeyOf } from "./selection";
import { timelineViewportRegistry } from "./timelineViewportRegistry";
import type {
  AnnouncedJobKind,
  AnnounceOptions,
  ChromeFlags,
  CommentDraft,
  DawStore,
  FeedbackToast,
  JobFeedback,
  JobStartToken,
  LaneHeightMode,
  LayerVisibility,
  PointerKind,
  RangeDraft,
  ShellBreakpoint,
  ToastTone,
  TranscriptInlineEditFailure,
  TranscriptInlineEditRequest,
} from "./types";

/** Most job ids `useJobStatusAnnouncement` remembers as spoken (oldest dropped first, #704). */
export const SPOKEN_JOB_RESULT_LIMIT = 16;

/** Time-column width guess (px) for a shell whose timeline has not measured. */
export function estimateTimelineViewportWidth(bp: ShellBreakpoint): number {
  const w = cssViewportWidth();
  if (bp === "phone") return Math.max(200, w);
  if (bp === "tablet") return Math.max(200, w - 200);
  return Math.max(200, w - 500);
}

/** A repeat of the last announcement within this window is the same outcome told twice. */
const REPEAT_WINDOW_MS = 1000;
let lastSpoken: {
  message: string;
  at: number;
  /** The toast it raised, or null when it was spoken only (`toast: false`). */
  toastId: number | null;
  tone: ToastTone;
} | null = null;

/** True when `message` (as shown, after the error filter) was announced within the repeat window. */
export function justAnnounced(message: string): boolean {
  return (
    lastSpoken != null &&
    Date.now() - lastSpoken.at < REPEAT_WINDOW_MS &&
    (lastSpoken.message === message ||
      lastSpoken.message === plainError(message))
  );
}

/**
 * A repeat is absorbed only when it adds nothing: the same text is still
 * standing as a toast, or a handler spoke its refusal without a toast and the
 * caller re-announces the same result.
 */
function repeatsStanding(
  message: string,
  tone: ToastTone,
  standing: FeedbackToast | null,
): boolean {
  if (!lastSpoken || !justAnnounced(message)) return false;
  if (tone === "error" && lastSpoken.tone !== "error") return false;
  return lastSpoken.toastId != null
    ? standing?.id === lastSpoken.toastId
    : lastSpoken.tone === "error";
}

export function resetFeedbackRepeatForTests(): void {
  lastSpoken = null;
}

type FeedbackInput =
  | { kind: "public"; rawMessage: string; options: AnnounceOptions }
  | {
      kind: "jobs";
      message: string;
      verifiedToast: string;
      failure: boolean;
      ownedOutcome: boolean;
    };

function feedbackPatch(s: DawStore, input: FeedbackInput): Partial<DawStore> {
  const options: AnnounceOptions =
    input.kind === "public"
      ? input.options
      : input.verifiedToast
        ? {}
        : { toast: false, tone: input.failure ? "error" : "status" };
  const id = s.statusAnnouncementSeq + 1;
  const tone = options.tone ?? "status";
  const message =
    input.kind === "jobs"
      ? input.message
      : tone === "error"
        ? plainError(input.rawMessage)
        : input.rawMessage;
  const showToast = message !== "" && options.toast !== false;
  if (
    !(input.kind === "jobs" && input.ownedOutcome) &&
    message !== "" &&
    !options.undo &&
    !options.reverse &&
    !options.gesture &&
    repeatsStanding(message, tone, s.feedbackToast)
  )
    return {};
  if (message !== "")
    lastSpoken = {
      message,
      at: Date.now(),
      toastId: showToast ? id : null,
      tone,
    };
  return {
    statusAnnouncement: message,
    statusAnnouncementSeq: id,
    ...(showToast
      ? {
          feedbackToast: {
            id,
            message: input.kind === "jobs" ? input.verifiedToast : message,
            tone,
            undo: options.undo ?? null,
            baseHead: s.project?.history?.head_id ?? null,
            reverse: options.reverse ?? null,
            onUndone: options.onUndone,
            returnFocus: options.returnFocus ?? null,
            gesture: options.gesture === true,
          },
        }
      : {}),
  };
}

function spokenResultsPatch(s: DawStore, jobIds: readonly string[]) {
  const spoken = new Set(jobIds);
  return {
    spokenJobResultIds: [
      ...s.spokenJobResultIds.filter((id) => !spoken.has(id)),
      ...jobIds,
    ].slice(-SPOKEN_JOB_RESULT_LIMIT),
  };
}

/** A toast that narrates a gesture ends with the gesture or the mode. */
function endGestureToast(
  s: Pick<DawStore, "feedbackToast">,
): Pick<DawStore, "feedbackToast"> | Record<string, never> {
  return s.feedbackToast?.gesture ? { feedbackToast: null } : {};
}

/** Save the waveform view of the open project (per browser). */
function persistWaveformView(s: DawStore): void {
  if (s.guestMode != null) return;
  writeWaveformViewPref(s.projectPath, {
    scale: s.waveformScale,
    amp: s.waveformAmpZoom,
    postFader: s.waveformPostFader,
  });
}

type UiSlice = Pick<
  DawStore,
  | "highlightStaleRender"
  | "renderPreviewBusy"
  | "ingestBusy"
  | "ingestFileCount"
  | "ingestDropTrackId"
  | "statusAnnouncement"
  | "statusAnnouncementSeq"
  | "feedbackToast"
  | "jobFeedback"
  | "jobResultStarts"
  | "beginJobResultStart"
  | "bindJobResultStart"
  | "releaseJobResultStart"
  | "finishJobResult"
  | "reconcileJobAnnouncements"
  | "spokenJobResultIds"
  | "setHighlightStaleRender"
  | "setRenderPreviewBusy"
  | "setIngestBusy"
  | "setIngestDropTrackId"
  | "announceStatus"
  | "endGestureFeedback"
  | "dismissFeedbackToast"
  | "dropFeedbackUndo"
  | "expectJobResult"
  | "settleJobResult"
  | "markJobResultsSpoken"
  | "zoomPxPerSec"
  | "waveformAmpZoom"
  | "waveformScale"
  | "waveformPostFader"
  | "pointerTrackId"
  | "setPointerTrackId"
  | "splitHoverSec"
  | "setSplitHoverSec"
  | "scrollLeft"
  | "timelineViewportWidth"
  | "setTimelineViewportWidth"
  | "resetTimelineViewportWidth"
  | "rangeArmed"
  | "rangeBusy"
  | "inspectorKey"
  | "setInspectorOpen"
  | "moreRequest"
  | "requestMore"
  | "setRangeArmed"
  | "rangeDraft"
  | "armRange"
  | "setRangeDraft"
  | "agentRangeScope"
  | "setAgentRangeScope"
  | "setRangeBusy"
  | "userZoomed"
  | "layers"
  | "commentDraft"
  | "transcriptFollowPlayhead"
  | "transcriptInlineEditRequest"
  | "setTranscriptInlineEditRequest"
  | "transcriptInlineEditFailure"
  | "chapterAddPending"
  | "chrome"
  | "setTranscriptFindReplaceOpen"
  | "showCutAwayUtterances"
  | "timelineFocused"
  | "shellBreakpoint"
  | "pointerKind"
  | "selectionHit"
  | "inspectorSelection"
  | "timelineDragging"
  | "snapEnabled"
  | "laneHeightMode"
  | "laneHeightPx"
  | "drawnLaneHeightPx"
  | "setZoomPxPerSec"
  | "setWaveformAmpZoom"
  | "nudgeWaveformAmp"
  | "setWaveformScale"
  | "setWaveformPostFader"
  | "setScrollLeft"
  | "selectFromInspector"
  | "setTranscriptFollowPlayhead"
  | "toggleTranscriptFollowPlayhead"
  | "setTranscriptInlineEditFailure"
  | "setChapterAddPending"
  | "setShowCutAwayUtterances"
  | "toggleShowCutAwayUtterances"
  | "setTimelineFocused"
  | "markUserZoomed"
  | "applyAnchoredZoom"
  | "zoomToSpan"
  | "setLayerVisible"
  | "setCommentDraft"
  | "setShellBreakpoint"
  | "setPointerKind"
  | "setSelectionHit"
  | "setTimelineDragging"
  | "setSnapEnabled"
  | "setLaneHeightMode"
  | "toggleFitTracksHeight"
  | "stepLaneHeight"
  | "setDrawnLaneHeightPx"
  | "setCommandPaletteOpen"
  | "toggleCommandPalette"
  | "bounceRangeTarget"
  | "setBounceRangeTarget"
  | "setBounceRequested"
  | "setExportRequested"
  | "prepareFocusTrackId"
  | "setPrepareFocusTrackId"
  | "setTranscriptRequested"
  | "setHostMcpDialogOpen"
  | "setHelpDialogOpen"
  | "setModelsSheetOpen"
  | "joinMutationInFlight"
  | "setJoinMutationInFlight"
  | "joinDraft"
  | "setJoinDraft"
  | "rippleTrim"
  | "setRippleTrim"
  | "fitToWindow"
  | "measureTimelineViewport"
>;

/** UI state `hydrate` clears on every call. */
export function uiAlwaysInitial() {
  return {
    transcriptInlineEditRequest: null as TranscriptInlineEditRequest | null,
    ingestBusy: false,
    ingestFileCount: 0,
    ingestDropTrackId: null as string | null,
  };
}

/** UI state tied to one project; `hydrate` clears it when the project path changes. */
export function uiProjectInitial() {
  return {
    highlightStaleRender: false,
    renderPreviewBusy: false,
    chapterAddPending: false,
    joinMutationInFlight: false,
    joinDraft: null,
    rippleTrim: null,
    rangeArmed: false,
    rangeDraft: null as RangeDraft | null,
    agentRangeScope: null as readonly string[] | null,
    rangeBusy: false,
    inspectorKey: null as string | null,
    bounceRangeTarget: null,
    prepareFocusTrackId: null,
    feedbackToast: null,
    jobFeedback: new Map<string, JobFeedback>(),
    jobResultStarts: new Map<JobStartToken, AnnouncedJobKind>(),
    spokenJobResultIds: [] as readonly string[],
  };
}

export function chromeInitial(): ChromeFlags {
  return {
    commandPaletteOpen: false,
    bounceRequested: false,
    exportRequested: false,
    transcriptRequested: false,
    hostMcpDialogOpen: false,
    helpDialogOpen: false,
    modelsSheetOpen: false,
    transcriptFindReplaceOpen: false,
  };
}

export const createUiSlice: StateCreator<DawStore, [], [], UiSlice> = (
  set,
  get,
) => {
  const lanePref = readLaneHeightPref();
  return {
    ...uiAlwaysInitial(),
    ...uiProjectInitial(),
    statusAnnouncement: "",
    statusAnnouncementSeq: 0,
    setHighlightStaleRender: (highlightStaleRender) =>
      set({ highlightStaleRender }),
    setRenderPreviewBusy: (renderPreviewBusy) => set({ renderPreviewBusy }),
    setIngestBusy: (ingestBusy, ingestFileCount = 0) =>
      set({ ingestBusy, ingestFileCount }),
    setIngestDropTrackId: (ingestDropTrackId) => set({ ingestDropTrackId }),
    announceStatus: (rawMessage, options = {}) =>
      set((s) => {
        return feedbackPatch(s, { kind: "public", rawMessage, options });
      }),
    endGestureFeedback: () => {
      lastSpoken = null;
      set(endGestureToast);
    },
    dismissFeedbackToast: (id) =>
      set((s) => (s.feedbackToast?.id === id ? { feedbackToast: null } : {})),
    dropFeedbackUndo: (id) =>
      set((s) =>
        s.feedbackToast?.id === id && s.feedbackToast.undo
          ? { feedbackToast: { ...s.feedbackToast, undo: null } }
          : {},
      ),
    expectJobResult: (jobId) =>
      set((s) => ({
        jobFeedback: new Map(s.jobFeedback).set(jobId, { kind: "known" }),
      })),
    settleJobResult: (jobId) =>
      set((s) => {
        if (s.jobFeedback.get(jobId)?.kind !== "known") return {};
        const jobFeedback = new Map(s.jobFeedback);
        jobFeedback.delete(jobId);
        return { jobFeedback };
      }),
    markJobResultsSpoken: (jobIds) =>
      set((s) => {
        const jobFeedback = new Map(s.jobFeedback);
        for (const id of jobIds) {
          if (jobFeedback.get(id)?.kind === "known") jobFeedback.delete(id);
        }
        return { jobFeedback, ...spokenResultsPatch(s, jobIds) };
      }),
    beginJobResultStart: (kind) => {
      const token = { identity: Symbol(), projectEpoch: get().projectEpoch };
      set((s) => ({
        jobResultStarts: new Map(s.jobResultStarts).set(token, kind),
      }));
      return token;
    },
    bindJobResultStart: (owner) => {
      let bound = false;
      set((s) => {
        if (
          owner.start.projectEpoch !== s.projectEpoch ||
          !s.jobResultStarts.has(owner.start)
        )
          return {};
        const jobResultStarts = new Map(s.jobResultStarts);
        jobResultStarts.delete(owner.start);
        bound = true;
        return {
          jobResultStarts,
          jobFeedback: new Map(s.jobFeedback).set(owner.jobId, {
            kind: "following",
            owner,
          }),
        };
      });
      return bound;
    },
    finishJobResult: (owner, outcome) => {
      let finished = false;
      set((s) => {
        const record = s.jobFeedback.get(owner.jobId);
        if (
          owner.start.projectEpoch !== s.projectEpoch ||
          record?.kind !== "following" ||
          record.owner !== owner
        )
          return {};
        const jobFeedback = new Map(s.jobFeedback);
        if (outcome.kind === "cancelled-empty") jobFeedback.delete(owner.jobId);
        else jobFeedback.set(owner.jobId, { kind: "ready", outcome });
        finished = true;
        return { jobFeedback };
      });
      return finished;
    },
    releaseJobResultStart: (start, owner) =>
      set((s) => {
        if (start.projectEpoch !== s.projectEpoch) return {};
        if (s.jobResultStarts.has(start)) {
          const jobResultStarts = new Map(s.jobResultStarts);
          jobResultStarts.delete(start);
          return { jobResultStarts };
        }
        if (!owner) return {};
        const record = s.jobFeedback.get(owner.jobId);
        if (record?.kind !== "following" || record.owner !== owner) return {};
        return {
          jobFeedback: new Map(s.jobFeedback).set(owner.jobId, {
            kind: "unverified",
          }),
        };
      }),
    reconcileJobAnnouncements: (observation, chipId, chipTerminal) =>
      set((s) => {
        const jobFeedback = new Map(s.jobFeedback);
        const live = new Map<string | undefined, string>();
        if (observation) {
          const { id, kind, status, copy } = observation;
          const spoken = id !== undefined && s.spokenJobResultIds.includes(id);
          if (status === "ok" && id !== undefined) {
            const previous = jobFeedback.get(id);
            if (!spoken && !previous) {
              const blockers = new Set(
                [...s.jobResultStarts]
                  .filter(
                    ([token, startKind]) =>
                      token.projectEpoch === s.projectEpoch &&
                      (kind === undefined || startKind === kind),
                  )
                  .map(([token]) => token),
              );
              jobFeedback.set(id, { kind: "deferred", copy, blockers });
            }
          } else if (
            (!spoken || !chipTerminal) &&
            (id === undefined ||
              jobFeedback.get(id)?.kind !== "failure-delivered")
          ) {
            live.set(id, copy);
          }
        }
        const verified: string[] = [];
        const delivered: string[] = [];
        let failure = false;
        for (const [id, record] of jobFeedback) {
          if (record.kind === "deferred") {
            if (
              [...record.blockers].some((token) => s.jobResultStarts.has(token))
            )
              continue;
            live.set(id, record.copy);
            jobFeedback.delete(id);
          } else if (record.kind === "ready") {
            if (record.outcome.kind === "verified") {
              if (id === chipId && !chipTerminal) continue;
              verified.push(record.outcome.copy);
              delivered.push(id);
              jobFeedback.delete(id);
              live.set(id, record.outcome.copy);
            } else {
              failure = true;
              jobFeedback.set(id, { kind: "failure-delivered" });
              live.set(id, plainError(record.outcome.copy));
            }
          }
        }
        const changed =
          jobFeedback.size !== s.jobFeedback.size ||
          [...jobFeedback].some(
            ([id, record]) => record !== s.jobFeedback.get(id),
          );
        if (live.size === 0) return changed ? { jobFeedback } : {};
        return {
          ...feedbackPatch(s, {
            kind: "jobs",
            message: joinJobCopy([...live.values()]),
            verifiedToast: joinJobCopy(verified),
            failure,
            ownedOutcome: failure || delivered.length > 0,
          }),
          ...spokenResultsPatch(s, delivered),
          ...(changed ? { jobFeedback } : {}),
        };
      }),

    zoomPxPerSec: 40,
    waveformAmpZoom: 1,
    waveformScale: DEFAULT_WAVEFORM_VIEW_PREF.scale,
    waveformPostFader: DEFAULT_WAVEFORM_VIEW_PREF.postFader,
    pointerTrackId: null as string | null,
    setPointerTrackId: (pointerTrackId) => set({ pointerTrackId }),
    splitHoverSec: null as number | null,
    setSplitHoverSec: (splitHoverSec) => {
      if (splitHoverSec !== get().splitHoverSec) {
        set({ splitHoverSec });
      }
    },
    scrollLeft: 0,
    // The desktop estimate (shellBreakpoint starts at desktop) until the
    // timeline measures, so first-render readers never see 0.
    timelineViewportWidth: estimateTimelineViewportWidth("desktop"),
    setTimelineViewportWidth: (px) => {
      // A hidden or zero-width scrollport measures 0: keep the shell estimate.
      const timelineViewportWidth =
        px > 0 ? px : estimateTimelineViewportWidth(get().shellBreakpoint);
      if (timelineViewportWidth !== get().timelineViewportWidth) {
        set({ timelineViewportWidth });
      }
    },
    resetTimelineViewportWidth: () =>
      get().setTimelineViewportWidth(
        estimateTimelineViewportWidth(get().shellBreakpoint),
      ),
    setRangeArmed: (rangeArmed) =>
      set({ rangeArmed, rangeDraft: null, agentRangeScope: null }),
    armRange: (rangeDraft) =>
      set({ rangeArmed: true, rangeDraft, agentRangeScope: null }),
    setRangeDraft: (rangeDraft) => set({ rangeDraft }),
    setAgentRangeScope: (agentRangeScope) => set({ agentRangeScope }),
    setRangeBusy: (rangeBusy) => set({ rangeBusy }),
    inspectorKey: null as string | null,
    setInspectorOpen: (open) =>
      set((s) => ({
        inspectorKey: open ? inspectKeyOf(s.selection) : null,
      })),
    moreRequest: 0,
    requestMore: () => set((s) => ({ moreRequest: s.moreRequest + 1 })),
    userZoomed: false,
    layers: {
      showLevels: false,
      showSilence: true,
      showProsody: false,
    } satisfies LayerVisibility,
    commentDraft: null as CommentDraft | null,
    transcriptFollowPlayhead: true,
    transcriptInlineEditFailure: null as TranscriptInlineEditFailure | null,
    showCutAwayUtterances: false,
    timelineFocused: true,
    shellBreakpoint: "desktop" as ShellBreakpoint,
    // Capability baseline; usePointerType() corrects this from matchMedia
    // before first paint and keeps it live from pointer events.
    pointerKind: "fine" as PointerKind,
    snapEnabled: readSnapPref(),
    laneHeightMode: lanePref.mode,
    laneHeightPx: lanePref.px,
    drawnLaneHeightPx: null as number | null,
    selectionHit: null,
    inspectorSelection: null,
    timelineDragging: false,
    setZoomPxPerSec: (zoomPxPerSec) =>
      set({
        zoomPxPerSec: clampZoomPxPerSec(zoomPxPerSec, sessionSecOf(get())),
      }),
    setWaveformAmpZoom: (waveformAmpZoom) => {
      set({ waveformAmpZoom: clampWaveformAmp(waveformAmpZoom) });
      persistWaveformView(get());
    },
    nudgeWaveformAmp: (direction) => {
      const cur = get().waveformAmpZoom;
      const next =
        direction === "in"
          ? cur * discreteZoomFactor("in")
          : cur * discreteZoomFactor("out");
      set({
        waveformAmpZoom: clampWaveformAmp(roundWaveformAmp(next)),
      });
      persistWaveformView(get());
    },
    setWaveformScale: (waveformScale) => {
      set({ waveformScale });
      persistWaveformView(get());
    },
    setWaveformPostFader: (waveformPostFader) => {
      set({ waveformPostFader });
      persistWaveformView(get());
    },
    setScrollLeft: (scrollLeft) => set({ scrollLeft }),
    selectFromInspector: (selection) => {
      set({ inspectorSelection: selection });
      get().setSelection(selection);
    },
    setTranscriptFollowPlayhead: (transcriptFollowPlayhead) =>
      set({ transcriptFollowPlayhead }),
    toggleTranscriptFollowPlayhead: () =>
      set((s) => ({ transcriptFollowPlayhead: !s.transcriptFollowPlayhead })),
    setTranscriptInlineEditRequest: (transcriptInlineEditRequest) =>
      set({ transcriptInlineEditRequest }),
    setTranscriptInlineEditFailure: (transcriptInlineEditFailure) =>
      set({ transcriptInlineEditFailure }),
    setChapterAddPending: (chapterAddPending) => set({ chapterAddPending }),
    setShowCutAwayUtterances: (showCutAwayUtterances) =>
      set({ showCutAwayUtterances }),
    toggleShowCutAwayUtterances: () =>
      set((s) => ({ showCutAwayUtterances: !s.showCutAwayUtterances })),
    setTimelineFocused: (timelineFocused) => set({ timelineFocused }),
    markUserZoomed: () => set({ userZoomed: true }),
    applyAnchoredZoom: (nextZoom, clientX) => {
      if (get().followingClientId) {
        get().stopFollow("local");
      }
      const el = timelineViewportRegistry.getTimelineElement();
      const currentZoom = get().zoomPxPerSec;
      const sessionSec = sessionSecOf(get());
      const z = clampZoomPxPerSec(nextZoom, sessionSec);
      if (!el) {
        set({ zoomPxPerSec: z, userZoomed: true });
        return;
      }
      const rect = el.getBoundingClientRect();
      const { headerOffsetPx: headerW, timeViewportPx: timeWidth } =
        measureTimelineColumns(el);
      // Sticky headers sit in the scrollport; time origin is to their right.
      const rectLeft = rect.left + headerW;
      if (clientX != null) {
        noteZoomPointerClientX(clientX);
      }
      const lead = timelineViewportRegistry.getLeadPx();
      // A fixed playhead's view may sit before time 0 (a scrub back from a
      // centered playhead); a zoom keeps that scroll but never opens it.
      const minScrollLeft = lead > 0 ? Math.min(0, get().scrollLeft) : 0;
      const endSec = get().project?.timeline_duration_sec ?? 0;
      if (lead > 0 && clientX == null) {
        // Command zoom (menu, keys) on a fixed playhead keeps the playhead's
        // time and its place in the view.
        const lineX = fixedLineOffsetPx(
          get().playheadSec,
          currentZoom,
          get().scrollLeft,
          timeWidth,
        );
        const scrollLeft = Math.min(
          maxLogicalScrollLeft(endSec, z),
          Math.max(minScrollLeft, get().playheadSec * z - lineX),
        );
        set({ zoomPxPerSec: z, scrollLeft, userZoomed: true });
        return;
      }
      const center = rectLeft + viewportCenterOffsetPx(timeWidth);
      // Command zoom keeps a visible playhead still (#533); pointer, then center.
      const playheadX =
        clientX == null
          ? visiblePlayheadClientX({
              playheadSec: get().playheadSec,
              zoomPxPerSec: currentZoom,
              scrollLeft: get().scrollLeft,
              rectLeft,
              viewportWidthPx: timeWidth,
            })
          : null;
      const anchorX =
        clientX ?? playheadX ?? peekZoomPointerClientX() ?? center;
      // Use store scroll/zoom so rapid pinch ticks do not re-anchor from a stale
      // DOM scrollLeft before useLayoutEffect applies the pending value.
      const { zoom, scrollLeft } = anchoredZoomScroll({
        currentZoom,
        nextZoom: z,
        clientX: anchorX,
        rectLeft,
        scrollLeft: get().scrollLeft,
        sessionSec,
        minScrollLeft,
        // A padded view's range ends with the session end at the left edge.
        maxScrollLeft: lead > 0 ? maxLogicalScrollLeft(endSec, z) : undefined,
      });
      // Store first; TimelineView applies el.scrollLeft in useLayoutEffect after
      // the wider (duration * zoom) content commits — avoids browser clamp.
      set({
        zoomPxPerSec: zoom,
        scrollLeft,
        userZoomed: true,
      });
    },
    zoomToSpan: (startSec, endSec, nextZoom) => {
      const el = timelineViewportRegistry.getTimelineElement();
      if (!el) {
        get().applyAnchoredZoom(nextZoom);
        return;
      }
      const { headerOffsetPx, timeViewportPx } = measureTimelineColumns(el);
      const centerPx = viewportCenterOffsetPx(timeViewportPx);
      // Center the span at the current zoom, then zoom about that center.
      set({
        scrollLeft: ((startSec + endSec) / 2) * get().zoomPxPerSec - centerPx,
      });
      get().applyAnchoredZoom(
        nextZoom,
        el.getBoundingClientRect().left + headerOffsetPx + centerPx,
      );
    },
    setLayerVisible: (key, visible) =>
      set((s) => ({ layers: { ...s.layers, [key]: visible } })),
    setCommentDraft: (commentDraft) => set({ commentDraft }),
    setShellBreakpoint: (shellBreakpoint) => {
      set({ shellBreakpoint });
      // Re-derive from the live timeline: a registered scrollport that measures
      // 0 (a remount mid shell switch) and no timeline at all both store the
      // new shell's estimate, never the previous shell's.
      get().setTimelineViewportWidth(get().measureTimelineViewport());
    },
    setPointerKind: (pointerKind) =>
      set((s) => (s.pointerKind === pointerKind ? s : { pointerKind })),
    setSelectionHit: (selectionHit) => set({ selectionHit }),
    setTimelineDragging: (timelineDragging) => {
      if (get().timelineDragging !== timelineDragging)
        set({ timelineDragging });
    },
    setSnapEnabled: (snapEnabled) => {
      set({ snapEnabled });
      writeSnapPref(snapEnabled);
    },
    setLaneHeightMode: (laneHeightMode: LaneHeightMode) => {
      set({ laneHeightMode });
      writeLaneHeightPref({ mode: laneHeightMode, px: get().laneHeightPx });
    },
    toggleFitTracksHeight: () =>
      get().setLaneHeightMode(get().laneHeightMode === "fit" ? "fixed" : "fit"),
    stepLaneHeight: (direction: "up" | "down") => {
      // From fit mode, step from the height the lanes are drawn at, so
      // Increase never shrinks them and Decrease never grows them.
      const { laneHeightMode, laneHeightPx: saved, drawnLaneHeightPx } = get();
      const from =
        laneHeightMode === "fit" && drawnLaneHeightPx != null
          ? drawnLaneHeightPx
          : saved;
      const laneHeightPx = stepLaneHeightPx(from, direction);
      set({ laneHeightMode: "fixed", laneHeightPx });
      writeLaneHeightPref({ mode: "fixed", px: laneHeightPx });
    },
    setDrawnLaneHeightPx: (drawnLaneHeightPx) => {
      if (get().drawnLaneHeightPx !== drawnLaneHeightPx) {
        set({ drawnLaneHeightPx });
      }
    },
    chrome: chromeInitial(),
    setTranscriptFindReplaceOpen: (on) =>
      set((s) => ({ chrome: { ...s.chrome, transcriptFindReplaceOpen: on } })),
    setCommandPaletteOpen: (on) =>
      set((s) => ({
        chrome: {
          ...s.chrome,
          commandPaletteOpen: on,
        },
      })),
    toggleCommandPalette: () =>
      set((s) => ({
        chrome: {
          ...s.chrome,
          commandPaletteOpen: !s.chrome.commandPaletteOpen,
        },
      })),
    setBounceRangeTarget: (bounceRangeTarget) => set({ bounceRangeTarget }),
    setBounceRequested: (on) =>
      set((s) => ({ chrome: { ...s.chrome, bounceRequested: on } })),
    setExportRequested: (on) =>
      set((s) => ({ chrome: { ...s.chrome, exportRequested: on } })),
    setPrepareFocusTrackId: (prepareFocusTrackId) =>
      set({ prepareFocusTrackId }),
    setTranscriptRequested: (on) =>
      set((s) => ({ chrome: { ...s.chrome, transcriptRequested: on } })),
    setHostMcpDialogOpen: (on) =>
      set((s) => ({ chrome: { ...s.chrome, hostMcpDialogOpen: on } })),
    setHelpDialogOpen: (on) =>
      set((s) => ({ chrome: { ...s.chrome, helpDialogOpen: on } })),
    setModelsSheetOpen: (on) =>
      set((s) => ({ chrome: { ...s.chrome, modelsSheetOpen: on } })),
    setJoinMutationInFlight: (joinMutationInFlight) =>
      set({ joinMutationInFlight }),
    setJoinDraft: (joinDraft) => set({ joinDraft }),
    setRippleTrim: (rippleTrim) => set({ rippleTrim }),
    fitToWindow: (viewportWidth) => {
      const duration = sessionSecOf(get());
      if (duration > 0 && viewportWidth > 0) {
        timelineViewportRegistry.setVisualPan(null);
        timelineViewportRegistry.setLayoutProjection(null);
        const zoom = fitZoomPxPerSec(viewportWidth, duration);
        // The whole session fits, so a fit starts at time 0 and the playhead
        // sits at its place in it, fixed playhead or not.
        set({ zoomPxPerSec: zoom, scrollLeft: 0, userZoomed: false });
      }
    },
    measureTimelineViewport: () => {
      const el = timelineViewportRegistry.getTimelineElement();
      return el
        ? timelineTimeViewportWidth(el)
        : estimateTimelineViewportWidth(get().shellBreakpoint);
    },
  };
};
