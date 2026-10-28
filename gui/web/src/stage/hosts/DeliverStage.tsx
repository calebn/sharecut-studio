import { memo, useEffect, useMemo } from "react";
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
  type DeliverPage,
  patchDeliverDraft,
  sendDeliverEdit,
  useDeliverDraft,
} from "./deliverDraft";
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
} from "./deliverModel";
import { HostBody } from "./HostBody";
import { hostStateOf } from "./hostModels";

export type DeliverStageProps = {
  loadFailure?: LoadFailure | null;
};

const DELIVER_COMMANDS = new Set([
  "AddChapter",
  "UpdateChapter",
  "DeleteChapter",
  "UpdateSocialClip",
  "DeleteSocialClip",
]);

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

function DeliverStageAdapter({ loadFailure }: DeliverStageProps) {
  const { project, projectPath } = useDawStore(
    useShallow((s) => ({ project: s.project, projectPath: s.projectPath })),
  );
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
          clipUndo={false}
          showClipEdits={false}
          onChapters={onChapters}
          onClips={onClips}
          onFix={(stage, target) => runFix(fixRoute(stage, target))}
          onExport={() => runPointerCommand("export.deliverables")}
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
    </HostBody>
  );
}

/**
 * The Deliver stage host: the Deliver stage on the open project, with chapter
 * and clip edits written back to the document. Export, Bounce and Share still
 * open their dialogs, which stay mounted in `DawApp`. Host only.
 */
export const DeliverStage = memo(DeliverStageAdapter);
