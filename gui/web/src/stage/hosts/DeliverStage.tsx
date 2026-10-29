import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  addChapter,
  deleteChapter,
  deleteSocialClip,
  updateChapter,
  updateSocialClip,
} from "../../api";
import { runPointerCommand } from "../../commands/pointer";
import { seekTransport } from "../../commands/seek";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { Slot } from "../../extensions/Slot";
import { useNowSec } from "../../hooks/useNowSec";
import { useStaleRenderBreakdown } from "../../hooks/useStaleRenderBreakdown";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useOfflineAttention } from "../../services/offlineQueue/offlineAttention";
import { DeliverStage as DeliverStageBody } from "../../stages/deliver/DeliverStage";
import {
  type Chapter,
  type Clip,
  type ExportRequest,
  exportBlocker,
  exportRequest,
} from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { selectedTrackIdsOf } from "../../state/selection";
import { StatusRow } from "../../system/StatusRow";
import { lowConfidenceStops } from "../../transcript/lowConfidence";
import { Button } from "../../ui";
import { useCommand } from "../../ui/useCommand";
import type { LoadFailure } from "../frame/LoadFailureBanner";
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
  deliverFacts,
  editHeadOf,
  type FixRoute,
  fixRoute,
  sameChapters,
  sameClipBounds,
} from "./deliverModel";
import { useExportFlow } from "./exportFlowContext";
import { HostBody } from "./HostBody";
import { hostStateOf } from "./hostModels";

export type DeliverStageProps = {
  loadFailure?: LoadFailure | null;
};

let liveHosts = 0;

const DELIVER_COMMANDS = new Set([
  "AddChapter",
  "UpdateChapter",
  "DeleteChapter",
  "UpdateSocialClip",
  "DeleteSocialClip",
]);

async function saveChapterOp(path: string, op: ChapterOp) {
  if (op.kind === "add") await addChapter(path, op.at, op.title);
  else if (op.kind === "delete") await deleteChapter(path, op.at, op.title);
  else await updateChapter(path, op.from.at, op.from.title, op.at, op.title);
}

async function saveClipOp(path: string, op: ClipOp) {
  if (op.kind === "delete") await deleteSocialClip(path, op.id);
  else await updateSocialClip(path, op.id, op.start, op.end);
}

function runFix(route: FixRoute) {
  if (route.kind === "refreshMix") runPointerCommand("render.refreshMix");
  else
    runPointerCommand(
      `stage.${route.stage}`,
      route.section ? { section: route.section } : {},
    );
}

function playFrom(seconds: number) {
  void seekTransport(seconds);
}

function DeliverStageAdapter({ loadFailure }: DeliverStageProps) {
  const {
    project,
    projectPath,
    exportRequested,
    setExportRequested,
    bounceRequested,
    setBounceRequested,
    bounceRange,
    setBounceRange,
    selection,
    soloTracks,
    sessionRegion,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      exportRequested: s.chrome.exportRequested,
      setExportRequested: s.setExportRequested,
      bounceRequested: s.chrome.bounceRequested,
      setBounceRequested: s.setBounceRequested,
      bounceRange: s.bounceRangeTarget,
      setBounceRange: s.setBounceRangeTarget,
      selection: s.selection,
      soloTracks: s.soloTracks,
      sessionRegion: s.sessionRegion,
    })),
  );
  const exportFlow = useExportFlow();
  const { reload: reloadExportSettings, start: startExport } = exportFlow;
  const bounceFlow = useBounceFlow();
  const nowSec = useNowSec(
    exportFlow.run.kind === "running" || bounceFlow.run.kind === "running",
  );
  const exportCmd = useCommand("export.deliverables");
  const shell = useViewportClass();
  const scrollRef = useStageScroll("deliver", "body", ".dv-page");
  const breakdown = useStaleRenderBreakdown(project);
  const bounceCmd = useCommand("export.bounce");
  const shareCmd = useCommand("share.manage");
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
    (draft.pending > 0 ? "Saving your changes first." : undefined);
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
  const exportOptions = exportOptionsOf(exportFlow);
  const formatsBlocker =
    exportFlow.loading || exportFlow.settings === null
      ? undefined
      : exportBlocker(episodeSettings, undefined, {
          wavAlwaysWritten: exportFlow.settings.wav,
          formats: exportOptions.formats,
        });
  const guardedStart = useCallback(
    (keys: readonly string[], request: ExportRequest) => {
      if (formatsBlocker) return;
      startExport(keys, request);
    },
    [formatsBlocker, startExport],
  );
  useEffect(() => {
    liveHosts += 1;
    return () => {
      liveHosts -= 1;
      window.setTimeout(() => {
        if (liveHosts > 0) return;
        useDawStore.getState().setExportRequested(false);
        useDawStore.getState().setBounceRequested(false);
      }, 0);
    };
  }, []);
  const settingsCurrent =
    wantedSettings.current !== null &&
    exportFlow.loadedGeneration >= wantedSettings.current;
  useEffect(() => {
    if (
      !exportRequested ||
      state !== "ready" ||
      exportFlow.loading ||
      !settingsCurrent ||
      exportBlockedReason
    )
      return;
    setExportRequested(false);
    guardedStart(
      chosenFormats,
      exportRequest(
        episodeSettings,
        page.clips,
        page.chapters,
        undefined,
        edits,
        exportOptions.target,
      ),
    );
  }, [
    exportRequested,
    state,
    exportFlow.loading,
    settingsCurrent,
    exportBlockedReason,
    setExportRequested,
    guardedStart,
    chosenFormats,
    episodeSettings,
    page.clips,
    page.chapters,
    edits,
    exportOptions.target,
  ]);
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
      !sameClipBounds(page.clips, clipsOf(docClips ?? []))
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
    commit({ clips: [...next] });
    if (ops.length === 0) return;
    sendDeliverEdit(projectPath, async (path) => {
      for (const op of ops) await saveClipOp(path, op);
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
    unsureWordsLeft: lowConfidenceStops(
      project.transcript?.utterances ?? [],
      false,
      false,
    ).length,
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
          exportState={exportStateOf(exportFlow, nowSec)}
          exportOptions={{
            ...exportOptions,
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
          env="none"
          getPlayheadSec={() => useDawStore.getState().playheadSec}
          layout={shell === "phone" ? "phone" : "desktop"}
          showLink={false}
          showPlayer={false}
          clipUndo={false}
          showClipEdits={false}
          onChapters={onChapters}
          onClips={onClips}
          onFix={(stage, target) => runFix(fixRoute(stage, target))}
          onExport={(request) =>
            guardedStart(request.settings.formats, request)
          }
          onCancel={exportFlow.cancel}
          onPlayFrom={playFrom}
          onPlayClip={playClip}
          onFindClips={() => runPointerCommand("stage.edit")}
          onOpenClipInEdit={(id) => {
            playClip(id);
            runPointerCommand("stage.edit");
          }}
        />
        <div className="stage-host-actions">
          <Slot id={FEATURE_SHARE_UI_MENU}>
            <Button
              disabledReason={shareCmd.whenReason}
              onClick={() => runPointerCommand("share.manage")}
            >
              Share a listen link
            </Button>
          </Slot>
        </div>
      </div>
    </HostBody>
  );
}

/**
 * The Deliver stage host: the Deliver stage on the open project, with chapter
 * and clip edits written back to the document, and the export run by the
 * flows in `DawApp`. Share still opens its dialog. Host only.
 */
export const DeliverStage = memo(DeliverStageAdapter);
