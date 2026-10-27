import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { canRefreshMix } from "../../shareMode";
import { DeliverStage as DeliverStageBody } from "../../stages/deliver/DeliverStage";
import {
  type Chapter,
  type Clip,
  exportRequest,
} from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { selectedTrackIdsOf } from "../../state/selection";
import { lowConfidenceStops } from "../../transcript/lowConfidence";
import { Button } from "../../ui";
import { useCommand } from "../../ui/useCommand";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import { useBounceFlow } from "./bounceFlowContext";
import { DeliverStageView } from "./DeliverStageView";
import { bounceOptionsOf } from "./deliverBounce";
import { exportOptionsOf, exportStateOf } from "./deliverExport";
import {
  type ChapterOp,
  type ClipOp,
  chapterOps,
  chaptersOf,
  clipOps,
  clipsOf,
  deliverFacts,
  fixRoute,
  sameChapters,
  sameClipBounds,
} from "./deliverModel";
import { useExportFlow } from "./exportFlowContext";
import { deliverReadiness, hostStateOf, type ReadinessRow } from "./hostModels";

export type DeliverStageProps = {
  loadFailure?: LoadFailure | null;
};

async function saveChapterOp(path: string, op: ChapterOp) {
  if (op.kind === "add") await addChapter(path, op.at, op.title);
  else if (op.kind === "delete") await deleteChapter(path, op.at, op.title);
  else await updateChapter(path, op.from.at, op.from.title, op.at, op.title);
}

async function saveClipOp(path: string, op: ClipOp) {
  if (op.kind === "delete") await deleteSocialClip(path, op.id);
  else await updateSocialClip(path, op.id, op.start, op.end);
}

function DeliverStageAdapter({ loadFailure }: DeliverStageProps) {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    exportRequested,
    setExportRequested,
    bounceRequested,
    setBounceRequested,
    selection,
    soloTracks,
    sessionRegion,
    bounceRangeTarget,
    setBounceRangeTarget,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      exportRequested: s.chrome.exportRequested,
      setExportRequested: s.setExportRequested,
      bounceRequested: s.chrome.bounceRequested,
      setBounceRequested: s.setBounceRequested,
      selection: s.selection,
      soloTracks: s.soloTracks,
      sessionRegion: s.sessionRegion,
      bounceRangeTarget: s.bounceRangeTarget,
      setBounceRangeTarget: s.setBounceRangeTarget,
    })),
  );
  const exportFlow = useExportFlow();
  const { reload: reloadExportSettings } = exportFlow;
  const bounceFlow = useBounceFlow();
  const nowSec = useNowSec(
    exportFlow.run.kind === "running" || bounceFlow.run.kind === "running",
  );
  const shell = useViewportClass();
  const scrollRef = useStageScroll("deliver", "body");
  const breakdown = useStaleRenderBreakdown(project);
  const exportCmd = useCommand("export.deliverables");
  const shareCmd = useCommand("share.manage");
  const mayRefreshMix = canRefreshMix(
    projectPath,
    guestMode,
    shareCapabilities,
  );
  const mixStale = project != null && breakdown.stale;
  const mixMissing = project != null && breakdown.premixMissing;
  const state = hostStateOf(project, loadFailure);

  // What the document holds, as the stage last saw it. Edits are diffed
  // against it and it moves forward once they are sent.
  const saved = useRef<{
    from: object;
    chapters: Chapter[];
    clips: Clip[];
  } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const seed = useMemo(
    () => ({
      chapters: chaptersOf(project?.chapters ?? []),
      clips: clipsOf(project?.social_clips ?? []),
    }),
    // Seeded once per project; later edits come from the stage itself.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    [projectPath, state === "ready", epoch],
  );
  if (saved.current?.from !== seed) saved.current = { from: seed, ...seed };
  const send = (work: (path: string) => Promise<void>) => {
    if (!projectPath) return;
    setPending((n) => n + 1);
    queue.current = queue.current
      .then(() => work(projectPath))
      .then(() => setSaveError(null))
      .catch((error: unknown) =>
        setSaveError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setPending((n) => n - 1));
  };
  // A new history revision (Undo, Redo, an outside edit) that leaves the
  // chapters or clips different from what the page holds re-seeds the stage.
  // Never while a save is in flight, so an unsaved edit is not lost.
  const revision = project?.history.head_id;
  useEffect(() => {
    const held = saved.current;
    if (pending > 0 || !held || state !== "ready") return;
    const now = {
      chapters: chaptersOf(project?.chapters ?? []),
      clips: clipsOf(project?.social_clips ?? []),
    };
    if (
      !sameChapters(held.chapters, now.chapters) ||
      !sameClipBounds(held.clips, now.clips)
    ) {
      setEpoch((n) => n + 1);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs per revision and when saves settle
  }, [revision, pending, state]);
  // The Pipeline tab may have changed the formats since Deliver was last open.
  useEffect(() => {
    reloadExportSettings();
  }, [reloadExportSettings]);
  // A command asked for an export: start it once the stage and the formats are ready.
  const startRequested = exportFlow.start;
  const chosenFormats = exportFlow.selected;
  useEffect(() => {
    if (!exportRequested || state !== "ready" || exportFlow.loading) return;
    setExportRequested(false);
    startRequested(
      chosenFormats,
      exportRequest(
        {
          formats: chosenFormats,
          loudness: "podcast",
          part: { mode: "whole" },
        },
        saved.current?.clips ?? [],
        saved.current?.chapters ?? [],
      ),
    );
  }, [
    exportRequested,
    state,
    exportFlow.loading,
    setExportRequested,
    startRequested,
    chosenFormats,
  ]);
  const onChapters = (next: readonly Chapter[]) => {
    const base = saved.current?.chapters ?? [];
    const ops = chapterOps(base, next);
    saved.current = {
      from: seed,
      chapters: [...next],
      clips: saved.current?.clips ?? [],
    };
    send(async (path) => {
      for (const op of ops) await saveChapterOp(path, op);
    });
  };
  const onClips = (next: readonly Clip[]) => {
    const base = saved.current?.clips ?? [];
    const ops = clipOps(base, next);
    saved.current = {
      from: seed,
      chapters: saved.current?.chapters ?? [],
      clips: [...next],
    };
    send(async (path) => {
      for (const op of ops) await saveClipOp(path, op);
    });
  };

  const { rows, summary } = deliverReadiness({
    pendingReviewCount: project?.edit_impact.pending_review_count ?? 0,
    openCommentCount: project?.comments?.filter((c) => !c.resolved).length ?? 0,
    mixStale,
    mixMissing,
    mayRefreshMix,
  });
  const action = (
    label: string,
    command: ReturnType<typeof useCommand>,
    id: string,
  ) => ({
    label,
    disabledReason: command.whenReason,
    onClick: () => runPointerCommand(id),
  });

  if (state !== "ready" || !project) {
    const onFix = (row: ReadinessRow) => {
      const fix = row.fix;
      if (!fix) return;
      if (fix.kind === "refreshMix") runPointerCommand("render.refreshMix");
      else
        runPointerCommand(
          `stage.${fix.stage}`,
          fix.section ? { section: fix.section } : {},
        );
    };
    return (
      <DeliverStageView
        shell={shell}
        state={state}
        failure={loadFailure}
        summary={summary}
        rows={rows}
        onFix={onFix}
        exportAction={action("Export", exportCmd, "export.deliverables")}
        share={action("Share a listen link", shareCmd, "share.manage")}
        shareSlot={(content) => (
          <Slot id={FEATURE_SHARE_UI_MENU}>{content}</Slot>
        )}
        scrollRef={scrollRef}
      />
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
    mixUpToDate: !mixStale && !mixMissing,
    chapterCount: seed.chapters.length,
    removedSeconds: project.edit_impact.total_removed_sec,
  });
  const { run } = exportFlow;
  const measured =
    run.kind === "done"
      ? {
          measuredLufs: run.lufs ?? undefined,
          truePeak: run.truePeak ?? undefined,
        }
      : {};
  const playFrom = (sec: number) => {
    void seekTransport(sec);
  };
  return (
    <div className="stage-host-deliver">
      {saveError ? (
        <div className="guest-banner" role="alert">
          Could not save your changes: {saveError}
        </div>
      ) : null}
      <DeliverStageBody
        key={`${projectPath ?? "none"}:${epoch}`}
        facts={{ ...facts, ...measured }}
        total={project.timeline_duration_sec}
        initialSettings={{
          formats: exportFlow.selected,
          loudness: "podcast",
          part: { mode: "whole" },
        }}
        onSettings={(next) => exportFlow.setSelected(next.formats)}
        initialChapters={seed.chapters}
        initialClips={seed.clips}
        saveTo=""
        exportState={exportStateOf(exportFlow, nowSec)}
        exportOptions={exportOptionsOf(exportFlow)}
        bounce={bounceOptionsOf(bounceFlow, nowSec, {
          selectedCount: selectedTrackIdsOf(selection).length,
          soloCount: Object.values(soloTracks).filter(Boolean).length,
          hasRegion: sessionRegion !== null,
          range: bounceRangeTarget,
          clearRange: () => setBounceRangeTarget(null),
          focusRequested: bounceRequested,
          onFocused: () => setBounceRequested(false),
        })}
        env="none"
        clock={{ time: "", total: "" }}
        playhead={() => useDawStore.getState().playheadSec}
        link={{ url: null }}
        pinnedTo="the latest export"
        layout={shell === "phone" ? "phone" : "desktop"}
        showLink={false}
        onChapters={onChapters}
        onClips={onClips}
        onFix={(stage, target) => {
          const route = fixRoute(stage, target);
          if (route.kind === "refreshMix")
            runPointerCommand("render.refreshMix");
          else
            runPointerCommand(
              `stage.${route.stage}`,
              route.section ? { section: route.section } : {},
            );
        }}
        onExport={() => runPointerCommand("export.deliverables")}
        onCancel={exportFlow.cancel}
        onCopyLink={() => runPointerCommand("share.manage")}
        onRefreshMix={() => runPointerCommand("render.refreshMix")}
        onPlayFrom={playFrom}
        onPlayClip={(id) => {
          const clip = seed.clips.find((c) => c.id === id);
          if (clip) playFrom(clip.start);
        }}
        onFindClips={() => runPointerCommand("stage.edit")}
        onOpenClipInEdit={(id) => {
          const clip = seed.clips.find((c) => c.id === id);
          if (clip) playFrom(clip.start);
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
  );
}

/**
 * The Deliver stage host: the Deliver stage on the open project, with chapter
 * and clip edits written back to the document, and the export and bounce run
 * by the flows in `DawApp`. Share still opens its dialog. Host only.
 */
export const DeliverStage = memo(DeliverStageAdapter);
