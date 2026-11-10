import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  addChapter,
  deleteChapter,
  deleteSocialClip,
  proposeSocialClips,
  undoHistory,
  updateChapter,
  updateSocialClip,
  updateSocialClipDetails,
} from "../../api";
import { runPointerCommand } from "../../commands/pointer";
import { seekTransport } from "../../commands/seek";
import {
  type DocumentScope,
  documentScope,
} from "../../document/authorityState";
import { useTranscriptDetail } from "../../document/useTranscriptDetail";
import { useHasFeature } from "../../extensions/FeaturesContext";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { useNowSec } from "../../hooks/useNowSec";
import { useStaleRenderBreakdown } from "../../hooks/useStaleRenderBreakdown";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useOfflineAttention } from "../../services/offlineQueue/offlineAttention";
import { DeliverStage as DeliverStageBody } from "../../stages/deliver/DeliverStage";
import type { NamedExportFiles } from "../../stages/deliver/deliverFiles";
import {
  type Chapter,
  type Clip,
  type ExportRequest,
  exportBlocker,
  exportRequest,
} from "../../stages/deliver/deliverLogic";
import { FeedPanel } from "../../stages/deliver/FeedPanel";
import { useDawStore } from "../../state/dawStore";
import { selectedTrackIdsOf } from "../../state/selection";
import { StatusRow } from "../../system/StatusRow";
import { lowConfidenceStops } from "../../transcript/lowConfidence";
import type { LoudnessId } from "../../types/pipeline";
import type { HistoryEntryId } from "../../types/project";
import { useCommand } from "../../ui/useCommand";
import { shownTitle } from "../../utils/clipTitle";
import { mediaSignature } from "../../waveform/mediaRef";
import { ListenLinkRow } from "../frame/invite/ListenLinkRow";
import { useStageScroll } from "../useStageScroll";
import { useBounceFlow } from "./bounceFlowContext";
import { bounceOptionsOf } from "./deliverBounce";
import {
  type DeliverPage,
  patchDeliverDraft,
  sendDeliverEdit,
  useDeliverDraft,
} from "./deliverDraft";
import { exportOptionsOf, exportStateOf } from "./deliverExport";
import {
  type ChapterOp,
  type ClipOp,
  chapterOps,
  chaptersOf,
  clipOps,
  clipsOf,
  clipWordsOf,
  deliverFacts,
  editHeadOf,
  type FixRoute,
  fixRoute,
  sameChapters,
  sameClips,
} from "./deliverModel";
import { shareOptionsOf } from "./deliverShare";
import { useExportFlow } from "./exportFlowContext";
import { openFeedSource } from "./feedSource";
import { HostBody } from "./HostBody";
import { hostStateOf, type LoadFailure } from "./hostModels";
import { useShareFlow } from "./shareFlowContext";
import {
  hostFileAccess,
  namedExportFiles,
  useDeliverFiles,
} from "./useDeliverFiles";
import { useEpisodePeaks } from "./useEpisodePeaks";
import { useStallAnnouncement } from "./useStallAnnouncement";
import { useTranscriptFlow } from "./useTranscriptFlow";

export type DeliverStageProps = {
  loadFailure?: LoadFailure | null;
};

let liveHosts = 0;

const DELIVER_COMMANDS = new Set([
  "AddChapter",
  "UpdateChapter",
  "DeleteChapter",
  "UpdateSocialClip",
  "UpdateSocialClipDetails",
  "DeleteSocialClip",
]);

async function saveChapterOp(path: string, op: ChapterOp) {
  if (op.kind === "add") await addChapter(path, op.at, op.title);
  else if (op.kind === "delete") await deleteChapter(path, op.at, op.title);
  else await updateChapter(path, op.from.at, op.from.title, op.at, op.title);
}

async function saveClipOp(
  path: string,
  op: ClipOp,
  onRemoved: (id: string, head: HistoryEntryId | null) => void,
) {
  if (op.kind === "delete")
    onRemoved(op.id, await deleteSocialClip(path, op.id));
  else if (op.kind === "details")
    await updateSocialClipDetails(path, op.id, {
      ...(op.title !== undefined && { title: op.title }),
      ...(op.approved !== undefined && { approved: op.approved }),
    });
  else await updateSocialClip(path, op.id, op.start, op.end);
}

function runFix(route: FixRoute) {
  if (route.kind === "refreshMix") runPointerCommand("render.refreshMix");
  else {
    if (route.comment) {
      const state = useDawStore.getState();
      const first = state.project?.comments
        ?.filter((c) => !c.resolved)
        .sort((a, b) => a.timeline_start - b.timeline_start)[0];
      if (first) state.setSelection({ kind: "comment", id: first.id });
    }
    runPointerCommand(
      `stage.${route.stage}`,
      route.section ? { section: route.section } : {},
    );
  }
}

function playFrom(seconds: number) {
  void seekTransport(seconds);
}

function exportVisitPending(
  wanted: number | null,
  served: number,
  initialLoading: boolean,
): boolean {
  return wanted === null || served < wanted || initialLoading;
}

function DeliverStageAdapter({ loadFailure }: DeliverStageProps) {
  const {
    project,
    projectPath,
    projectEpoch,
    exportRequested,
    setExportRequested,
    bounceRequested,
    setBounceRequested,
    transcriptRequested,
    setTranscriptRequested,
    bounceRange,
    setBounceRange,
    selection,
    soloTracks,
    sessionRegion,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      exportRequested: s.chrome.exportRequested,
      setExportRequested: s.setExportRequested,
      bounceRequested: s.chrome.bounceRequested,
      setBounceRequested: s.setBounceRequested,
      transcriptRequested: s.chrome.transcriptRequested,
      setTranscriptRequested: s.setTranscriptRequested,
      bounceRange: s.bounceRangeTarget,
      setBounceRange: s.setBounceRangeTarget,
      selection: s.selection,
      soloTracks: s.soloTracks,
      sessionRegion: s.sessionRegion,
    })),
  );
  const wordDetail = useTranscriptDetail();
  const exportFlow = useExportFlow();
  const { reload: reloadExportSettings, start: startExport } = exportFlow;
  const bounceFlow = useBounceFlow();
  const shareFlow = useShareFlow();
  const shareOffered = useHasFeature(FEATURE_SHARE_UI_MENU);
  const nowSec = useNowSec(
    exportFlow.run.kind === "running" || bounceFlow.run.kind === "running",
  );
  const announceStatus = useDawStore((s) => s.announceStatus);
  useStallAnnouncement(
    [
      {
        running:
          exportFlow.run.kind === "running" && !exportFlow.run.cancelling,
        tracked: exportFlow.job != null,
        lastProgressAt: exportFlow.job?.last_progress_at,
      },
      {
        running:
          bounceFlow.run.kind === "running" && !bounceFlow.run.cancelling,
        tracked: bounceFlow.job != null,
        lastProgressAt: bounceFlow.job?.last_progress_at,
      },
    ],
    nowSec,
    (message) => announceStatus(message, { toast: false }),
  );
  const exportDoneAt =
    exportFlow.run.kind === "done" || exportFlow.run.kind === "cancelled"
      ? exportFlow.run.finishedAt
      : exportFlow.run.kind === "failed"
        ? "failed"
        : 0;
  const exportCmd = useCommand("export.deliverables");
  const shell = useViewportClass();
  const scrollRef = useStageScroll("deliver", "body", ".dv-page");
  const breakdown = useStaleRenderBreakdown(project);
  const bounceCmd = useCommand("export.bounce");
  const shareCmd = useCommand("share.manage");
  const shareOptions = shareOptionsOf(shareFlow, {
    blockedReason: shareCmd.whenReason,
  });
  const offline = useOfflineAttention(projectPath);
  const state = hostStateOf(project, loadFailure);

  const draft = useDeliverDraft(projectPath);
  const seedKey = `${state === "ready"}|${draft.epoch}`;
  const docChapters = project?.chapters;
  const docClips = project?.social_clips;
  const seed = useMemo(
    () => ({
      key: seedKey,
      chapters: chaptersOf(docChapters ?? []),
      clips: clipsOf(docClips ?? []),
    }),
    [seedKey, docChapters, docClips],
  );
  const page = draft.page?.key === seedKey ? draft.page : seed;
  const refused = offline.conflicts.filter(
    (c) =>
      c.kind === "refused" &&
      !c.dismissed &&
      DELIVER_COMMANDS.has(c.command.type) &&
      c.command.created_at >= draft.since &&
      c.command.created_at > draft.ackedAt,
  );
  const unsaved = draft.unsaved || refused.length > 0;
  const settling =
    draft.pending > 0 ||
    unsaved ||
    !offline.loaded ||
    offline.pending > 0 ||
    offline.settling;

  const wantedSettings = useRef<number | null>(null);
  useEffect(() => {
    wantedSettings.current = reloadExportSettings();
  }, [reloadExportSettings]);
  const exportBlockedReason =
    exportCmd.whenReason ??
    (draft.pending > 0 || offline.pending > 0
      ? "Saving your changes first."
      : unsaved
        ? "Some chapter or clip changes are not saved."
        : undefined);
  const chosenFormats = exportFlow.selected;
  const episodeSettings = useMemo(
    () => ({
      formats: chosenFormats,
      loudness: "podcast" as const,
      part: { mode: "whole" as const },
    }),
    [chosenFormats],
  );
  const edits = project ? editHeadOf(project.history) : undefined;
  const transcriptUtterances = project?.transcript?.utterances;
  const clipWords = useMemo(
    () => clipWordsOf(transcriptUtterances),
    [transcriptUtterances],
  );
  const peaks = useEpisodePeaks(
    state === "ready" ? projectPath : null,
    project?.timeline_duration_sec ?? 0,
    `${project?.history.head_id}|${mediaSignature(project)}`,
  );
  const transcriptFlow = useTranscriptFlow({
    projectPath,
    enabled: state === "ready",
    hasTranscript: project?.transcript != null,
    revision: project?.history.head_id,
  });
  const reloadTranscript = transcriptFlow.reload;
  const files = useDeliverFiles(
    projectPath,
    hostFileAccess(),
    `${projectEpoch}|${project?.history.head_id}|${exportDoneAt}|${transcriptFlow.written}`,
  );
  const exportRunning = exportFlow.run.kind === "running";
  const receipt = "receipt" in exportFlow.run ? exportFlow.run.receipt : null;
  const exportDone =
    exportFlow.run.kind === "done" && receipt?.kind === "canonical";
  const namedFiles: NamedExportFiles | undefined =
    receipt?.kind === "named"
      ? namedExportFiles(receipt, files)
      : exportFlow.request?.namedTarget
        ? { state: "unpublished" }
        : undefined;
  useEffect(() => {
    if (exportDone) reloadTranscript();
  }, [exportDone, reloadTranscript]);
  const [focusTranscript, setFocusTranscript] = useState(false);
  const clearTranscriptFocus = useCallback(() => setFocusTranscript(false), []);
  useEffect(() => {
    if (!transcriptRequested || state !== "ready") return;
    setTranscriptRequested(false);
    setFocusTranscript(true);
  }, [transcriptRequested, state, setTranscriptRequested]);
  const exportOptions = exportOptionsOf(exportFlow);
  const { loadedGeneration, loading: initialSettingsLoading } = exportFlow;
  const settingsPending = exportVisitPending(
    wantedSettings.current,
    loadedGeneration,
    initialSettingsLoading,
  );
  const formatsBlocker =
    settingsPending || exportFlow.settings === null
      ? undefined
      : exportBlocker(episodeSettings, undefined, {
          wavAlwaysWritten: exportFlow.settings.wav,
          formats: exportOptions.formats,
        });
  const feedExportBlockedReason =
    exportBlockedReason ??
    (settingsPending
      ? exportBlocker(episodeSettings, undefined, { loading: true })
      : formatsBlocker);
  const guardedStart = useCallback(
    (keys: readonly string[], request: ExportRequest) => {
      if (
        formatsBlocker ||
        exportBlockedReason ||
        exportVisitPending(
          wantedSettings.current,
          loadedGeneration,
          initialSettingsLoading,
        )
      )
        return;
      startExport(keys, request);
    },
    [
      formatsBlocker,
      exportBlockedReason,
      loadedGeneration,
      initialSettingsLoading,
      startExport,
    ],
  );
  const currentRequest = useCallback(
    (namedTarget: LoudnessId | null) =>
      exportRequest(
        episodeSettings,
        page.clips,
        page.chapters,
        undefined,
        edits,
        namedTarget,
      ),
    [episodeSettings, page.clips, page.chapters, edits],
  );
  useEffect(() => {
    liveHosts += 1;
    return () => {
      liveHosts -= 1;
      window.setTimeout(() => {
        if (liveHosts > 0) return;
        useDawStore.getState().setExportRequested(false);
        useDawStore.getState().setBounceRequested(false);
        useDawStore.getState().setTranscriptRequested(false);
      }, 0);
    };
  }, []);
  useEffect(() => {
    if (exportRequested && (unsaved || offline.pending > 0))
      setExportRequested(false);
  }, [exportRequested, unsaved, offline.pending, setExportRequested]);
  useEffect(() => {
    if (
      !exportRequested ||
      state !== "ready" ||
      settingsPending ||
      exportBlockedReason
    )
      return;
    setExportRequested(false);
    guardedStart(chosenFormats, currentRequest(exportFlow.loudness));
  }, [
    exportRequested,
    state,
    exportFlow.loudness,
    settingsPending,
    exportBlockedReason,
    setExportRequested,
    guardedStart,
    chosenFormats,
    currentRequest,
  ]);
  const removedAt = useRef(
    new Map<string, { head: HistoryEntryId; scope: DocumentScope }>(),
  );
  const [findingClips, setFindingClips] = useState(false);
  const [focusBounce, setFocusBounce] = useState(false);
  const clearBounceFocus = useCallback(() => setFocusBounce(false), []);
  useEffect(() => {
    if (!bounceRequested || state !== "ready") return;
    setBounceRequested(false);
    setFocusBounce(true);
  }, [bounceRequested, state, setBounceRequested]);
  useEffect(() => {
    if (!projectPath || state !== "ready" || draft.page?.key === seedKey)
      return;
    patchDeliverDraft(projectPath, () => ({ page: seed }));
  }, [projectPath, state, draft.page, seedKey, seed]);
  useEffect(() => {
    if (!projectPath || settling || state !== "ready") return;
    if (
      !sameChapters(page.chapters, chaptersOf(docChapters ?? [])) ||
      !sameClips(page.clips, clipsOf(docClips ?? []))
    ) {
      patchDeliverDraft(projectPath, (d) => ({ epoch: d.epoch + 1 }));
    }
  }, [projectPath, page, docChapters, docClips, settling, state]);

  const commit = (patch: Partial<Pick<DeliverPage, "chapters" | "clips">>) => {
    if (projectPath)
      patchDeliverDraft(projectPath, () => ({ page: { ...page, ...patch } }));
  };
  const onChapters = (next: readonly Chapter[]) => {
    if (!projectPath) return;
    const ops = chapterOps(page.chapters, next);
    commit({ chapters: [...next] });
    sendDeliverEdit(projectPath, async (path) => {
      for (const op of ops) await saveChapterOp(path, op);
    });
  };
  const onClips = (next: readonly Clip[]) => {
    if (!projectPath) return;
    const ops = clipOps(page.clips, next);
    commit({ clips: next.map((c) => ({ ...c, title: shownTitle(c.title) })) });
    if (ops.length === 0) return;
    const scope = documentScope();
    const rememberRemoval = (id: string, head: HistoryEntryId | null) => {
      if (head) removedAt.current.set(id, { head, scope });
    };
    sendDeliverEdit(projectPath, async (path) => {
      for (const op of ops) await saveClipOp(path, op, rememberRemoval);
    });
  };
  const onClipRestore = (clip: Clip) => {
    if (!projectPath) return;
    sendDeliverEdit(projectPath, async (path) => {
      const removal = removedAt.current.get(clip.id);
      removedAt.current.delete(clip.id);
      if (!removal) throw new Error("The removal has no history entry.");
      await undoHistory(path, {
        expectedHeadId: removal.head,
        scope: removal.scope,
      });
    });
  };

  const onFindClips = () => {
    if (!projectPath || findingClips) return;
    setFindingClips(true);
    // The project refreshes through document sync; the body remounts with the new clips.
    sendDeliverEdit(projectPath, async (path) => {
      try {
        await proposeSocialClips(path);
      } finally {
        setFindingClips(false);
      }
    });
  };

  if (state !== "ready" || !project) {
    return (
      <HostBody
        stage="deliver"
        shell={shell}
        state={state}
        failure={loadFailure}
        scrollRef={scrollRef}
      >
        {null}
      </HostBody>
    );
  }

  const facts = deliverFacts({
    pendingReviewCount: project.edit_impact.pending_review_count,
    appliedEditCount: project.applied_edits.count,
    comments: project.comments ?? [],
    unsureWordsLeft:
      wordDetail.kind === "ready"
        ? lowConfidenceStops(project.transcript?.utterances ?? [], false, false)
            .length
        : wordDetail.kind === "failed"
          ? "failed"
          : "pending",
    mixUpToDate: !breakdown.stale && !breakdown.premixMissing,
    chapterCount: page.chapters.length,
    removedSeconds: project.edit_impact.total_removed_sec,
  });
  const playClip = (id: string) => {
    const clip = page.clips.find((c) => c.id === id);
    if (clip) playFrom(clip.start);
  };
  return (
    <HostBody
      stage="deliver"
      shell={shell}
      state={state}
      failure={loadFailure}
      scrollRef={scrollRef}
    >
      <div className="stage-host-deliver">
        {unsaved ? (
          <div className="stage-host-status" role="alert">
            <StatusRow
              density="alert"
              state="failed"
              title="Could not save your changes"
              detail="They are still on this page, but not in the project."
              action={{
                label: "Show the saved version",
                onAction: () =>
                  projectPath &&
                  patchDeliverDraft(projectPath, (d) => ({
                    unsaved: false,
                    epoch: d.epoch + 1,
                    ackedAt: Date.now(),
                  })),
              }}
            />
          </div>
        ) : offline.pending > 0 ? (
          <div className="stage-host-status" role="status">
            <StatusRow
              density="alert"
              state="queued"
              title="Not saved yet"
              detail={`${offline.pending} waiting to send. Kept on this device.`}
            />
          </div>
        ) : null}
        <DeliverStageBody
          key={`${projectPath}|${page.key}`}
          facts={facts}
          total={project.timeline_duration_sec}
          initialSettings={episodeSettings}
          initialChapters={page.chapters}
          initialClips={page.clips}
          exportState={exportStateOf(exportFlow, nowSec, settingsPending)}
          exportOptions={{
            ...exportOptions,
            loading: settingsPending,
            blockedReason: exportBlockedReason,
            edits,
            onFormats: exportFlow.setSelected,
          }}
          bounce={bounceOptionsOf(bounceFlow, nowSec, {
            selectedCount: selectedTrackIdsOf(selection).length,
            soloCount: Object.values(soloTracks).filter(Boolean).length,
            hasRegion: sessionRegion != null,
            range: bounceRange,
            clearRange: () => setBounceRange(null),
            blockedReason: bounceCmd.whenReason,
            focusRequested: focusBounce,
            onFocused: clearBounceFocus,
          })}
          feed={
            projectPath ? (
              <FeedPanel
                projectPath={projectPath}
                access="host"
                refreshKey={`${project.history.head_id}|${exportDoneAt}`}
                files={files}
                filesRunning={exportRunning}
                exportBlockedReason={feedExportBlockedReason}
                onCommand={(fix) => {
                  if (
                    fix.kind === "command" &&
                    fix.command === "export_episode"
                  ) {
                    guardedStart(chosenFormats, currentRequest(null));
                  }
                }}
                onOpenSource={openFeedSource}
              />
            ) : undefined
          }
          transcript={{
            preview: transcriptFlow.preview,
            run: transcriptFlow.run,
            choices: transcriptFlow.choices,
            onChoices: transcriptFlow.setChoices,
            exportRunning:
              exportFlow.run.kind === "running" ||
              bounceFlow.run.kind === "running",
            copyState: transcriptFlow.copyState,
            onExport: transcriptFlow.exportNow,
            onCopy: transcriptFlow.copyText,
            onRetry: transcriptFlow.reload,
            onPrepare: () => runPointerCommand("stage.prepare"),
            focusRequested: focusTranscript,
            onFocused: clearTranscriptFocus,
          }}
          listen={
            shareOffered
              ? ({ highlight, phone }) => (
                  <ListenLinkRow
                    options={shareOptions}
                    highlight={highlight}
                    compact={phone}
                  />
                )
              : undefined
          }
          files={files}
          namedFiles={namedFiles}
          getPlayheadSec={() => useDawStore.getState().playheadSec}
          words={clipWords}
          peaks={peaks}
          layout={shell === "phone" ? "phone" : "desktop"}
          showLink={shareOffered}
          showPlayer={false}
          onClipRestore={onClipRestore}
          clipTitleCommit
          onChapters={onChapters}
          onClips={onClips}
          onFix={(stage, target) => runFix(fixRoute(stage, target))}
          onExport={(request) =>
            guardedStart(request.settings.formats, request)
          }
          onCancel={exportFlow.cancel}
          onPlayFrom={playFrom}
          onPlayClip={playClip}
          findingClips={findingClips}
          onFindClips={onFindClips}
          onOpenClipInEdit={(id) => {
            playClip(id);
            runPointerCommand("stage.edit");
          }}
        />
      </div>
    </HostBody>
  );
}

/**
 * The Deliver stage host: the Deliver stage on the open project, with chapter
 * and clip edits written back to the document, and the export run by the
 * flows in `DawApp`. The Listen link row sits in the right column; the header
 * Invite opens the sheet with every link. Host only.
 */
export const DeliverStage = memo(DeliverStageAdapter);
