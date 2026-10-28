import { memo, useEffect, useRef, useState } from "react";
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
import { useOfflineAttention } from "../../services/offlineQueue/offlineAttention";
import { DeliverStage as DeliverStageBody } from "../../stages/deliver/DeliverStage";
import type {
  Chapter,
  Clip,
  EpisodeSettings,
  ExportState,
} from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { StatusRow } from "../../system/StatusRow";
import { lowConfidenceStops } from "../../transcript/lowConfidence";
import { Button } from "../../ui";
import { useCommand } from "../../ui/useCommand";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import {
  type ChapterOp,
  type ClipOp,
  chapterOps,
  chaptersOf,
  clipOps,
  clipsOf,
  deliverFacts,
  type FixRoute,
  fixRoute,
  sameChapters,
  sameClipBounds,
  withPageFields,
} from "./deliverModel";
import { HostBody } from "./HostBody";
import { hostStateOf } from "./hostModels";

export type DeliverStageProps = {
  loadFailure?: LoadFailure | null;
};

const NEVER: ExportState = { phase: "never" };
const SETTINGS: EpisodeSettings = {
  formats: ["mp3"],
  loudness: "podcast",
  part: { mode: "whole" },
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

function DeliverStageForProject({ loadFailure }: DeliverStageProps) {
  const { project, projectPath } = useDawStore(
    useShallow((s) => ({ project: s.project, projectPath: s.projectPath })),
  );
  const shell = useViewportClass();
  const scrollRef = useStageScroll("deliver", "body");
  const breakdown = useStaleRenderBreakdown(project);
  const bounceCmd = useCommand("export.bounce");
  const shareCmd = useCommand("share.manage");
  const offline = useOfflineAttention(projectPath);
  const state = hostStateOf(project, loadFailure);

  const queue = useRef<Promise<void>>(Promise.resolve());
  const [pending, setPending] = useState(0);
  const [unsaved, setUnsaved] = useState(false);
  const [reseed, setReseed] = useState<{ epoch: number; clips: Clip[] }>({
    epoch: 0,
    clips: [],
  });
  const seedKey = `${state === "ready"}|${reseed.epoch}`;
  const seed = () => ({
    key: seedKey,
    chapters: chaptersOf(project?.chapters ?? []),
    clips: withPageFields(clipsOf(project?.social_clips ?? []), reseed.clips),
  });
  const [page, setPage] = useState(seed);
  if (page.key !== seedKey) setPage(seed());

  const docChapters = project?.chapters;
  const docClips = project?.social_clips;
  const settling =
    pending > 0 || unsaved || offline.pending > 0 || offline.settling;
  useEffect(() => {
    if (settling || state !== "ready") return;
    if (
      !sameChapters(page.chapters, chaptersOf(docChapters ?? [])) ||
      !sameClipBounds(page.clips, clipsOf(docClips ?? []))
    ) {
      setReseed((r) => ({ epoch: r.epoch + 1, clips: page.clips }));
    }
  }, [page, docChapters, docClips, settling, state]);

  const send = (work: (path: string) => Promise<void>) => {
    if (!projectPath) return;
    setPending((n) => n + 1);
    queue.current = queue.current
      .then(() => work(projectPath))
      .catch(() => setUnsaved(true))
      .finally(() => setPending((n) => n - 1));
  };
  const commit = (patch: Partial<Pick<typeof page, "chapters" | "clips">>) =>
    setPage((now) => ({ ...now, ...patch }));
  const onChapters = (next: readonly Chapter[]) => {
    const ops = chapterOps(page.chapters, next);
    commit({ chapters: [...next] });
    send(async (path) => {
      for (const op of ops) await saveChapterOp(path, op);
    });
  };
  const onClips = (next: readonly Clip[]) => {
    const ops = clipOps(page.clips, next);
    commit({ clips: [...next] });
    send(async (path) => {
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
              onAction: () => setUnsaved(false),
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
        key={page.key}
        facts={facts}
        total={project.timeline_duration_sec}
        initialSettings={SETTINGS}
        initialChapters={page.chapters}
        initialClips={page.clips}
        exportState={NEVER}
        env="app"
        getPlayheadSec={() => useDawStore.getState().playheadSec}
        layout={shell === "phone" ? "phone" : "desktop"}
        showLink={false}
        showPlayer={false}
        showSettings={false}
        onChapters={onChapters}
        onClips={onClips}
        onFix={(stage, target) => runFix(fixRoute(stage, target))}
        onExport={() => runPointerCommand("export.deliverables")}
        onCopyLink={() => runPointerCommand("share.manage")}
        onRefreshMix={() => runPointerCommand("render.refreshMix")}
        onPlayFrom={playFrom}
        onPlayClip={playClip}
        onFindClips={() => runPointerCommand("stage.edit")}
        onOpenClipInEdit={(id) => {
          playClip(id);
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

function DeliverStageAdapter({ loadFailure }: DeliverStageProps) {
  const projectPath = useDawStore((s) => s.projectPath);
  return (
    <DeliverStageForProject
      key={projectPath ?? "none"}
      loadFailure={loadFailure}
    />
  );
}

/**
 * The Deliver stage host: the Deliver stage on the open project, with chapter
 * and clip edits written back to the document. Export, Bounce and Share still
 * open their dialogs, which stay mounted in `DawApp`. Host only.
 */
export const DeliverStage = memo(DeliverStageAdapter);
