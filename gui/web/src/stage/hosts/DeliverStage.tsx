import { memo, useMemo, useRef, useState } from "react";
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
import { useStaleRenderBreakdown } from "../../hooks/useStaleRenderBreakdown";
import { useViewportClass } from "../../hooks/useViewportClass";
import { canRefreshMix } from "../../shareMode";
import { DeliverStage as DeliverStageBody } from "../../stages/deliver/DeliverStage";
import type {
  Chapter,
  Clip,
  ExportState,
} from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { lowConfidenceStops } from "../../transcript/lowConfidence";
import { Button } from "../../ui";
import { useCommand } from "../../ui/useCommand";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import { DeliverStageView } from "./DeliverStageView";
import {
  type ChapterOp,
  type ClipOp,
  chapterOps,
  chaptersOf,
  clipOps,
  clipsOf,
  deliverFacts,
  fixRoute,
} from "./deliverModel";
import { deliverReadiness, hostStateOf, type ReadinessRow } from "./hostModels";

export type DeliverStageProps = {
  loadFailure?: LoadFailure | null;
};

const NEVER: ExportState = { phase: "never" };

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
  const { project, projectPath, guestMode, shareCapabilities, playheadSec } =
    useDawStore(
      useShallow((s) => ({
        project: s.project,
        projectPath: s.projectPath,
        guestMode: s.guestMode,
        shareCapabilities: s.shareCapabilities,
        playheadSec: s.playheadSec,
      })),
    );
  const shell = useViewportClass();
  const scrollRef = useStageScroll("deliver", "body");
  const breakdown = useStaleRenderBreakdown(project);
  const exportCmd = useCommand("export.deliverables");
  const bounceCmd = useCommand("export.bounce");
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
  const seed = useMemo(
    () => ({
      chapters: chaptersOf(project?.chapters ?? []),
      clips: clipsOf(project?.social_clips ?? []),
    }),
    // Seeded once per project; later edits come from the stage itself.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    [projectPath, state === "ready"],
  );
  if (saved.current?.from !== seed) saved.current = { from: seed, ...seed };
  const send = (work: (path: string) => Promise<void>) => {
    if (!projectPath) return;
    queue.current = queue.current
      .then(() => work(projectPath))
      .then(() => setSaveError(null))
      .catch((error: unknown) =>
        setSaveError(error instanceof Error ? error.message : String(error)),
      );
  };
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
        bounce={action("Bounce…", bounceCmd, "export.bounce")}
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
        key={projectPath ?? "none"}
        facts={facts}
        total={project.timeline_duration_sec}
        initialSettings={{
          formats: ["mp3"],
          loudness: "podcast",
          part: { mode: "whole" },
        }}
        initialChapters={seed.chapters}
        initialClips={seed.clips}
        saveTo=""
        exportState={NEVER}
        env="app"
        clock={{ time: "", total: "" }}
        playhead={playheadSec}
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
        onCancel={() => {}}
        onReveal={() => runPointerCommand("export.deliverables")}
        onDownload={() => runPointerCommand("export.deliverables")}
        onChangeFolder={() => runPointerCommand("export.deliverables")}
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
        <Button
          disabledReason={bounceCmd.whenReason}
          onClick={() => runPointerCommand("export.bounce")}
        >
          Bounce…
        </Button>
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
 * and clip edits written back to the document. Export, Bounce and Share still
 * open their dialogs, which stay mounted in `DawApp`. Host only.
 */
export const DeliverStage = memo(DeliverStageAdapter);
