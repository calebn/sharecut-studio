import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import { displayShortcutFor } from "../../keymap/registry";
import { PipelinePanel } from "../../panels/PipelinePanel";
import { canIngestMedia } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { isPipelineSlotBusy } from "../../utils/pipeline";
import { EmptySession } from "../edit/EmptySession";
import { useAudioDrop } from "../edit/useAudioDrop";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";

import { hostStateOf, prepareHandoff } from "./hostModels";
import { PrepareStageView } from "./PrepareStageView";

export type PrepareStageProps = {
  loadFailure?: LoadFailure | null;
};

function PrepareStageAdapter({ loadFailure }: PrepareStageProps) {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    pipelineJob,
    activityJob,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      pipelineJob: s.pipelineJob,
      activityJob: s.activityJob,
    })),
  );
  const shell = useViewportClass();
  const scrollRef = useStageScroll("prepare", "body");
  const drop = useAudioDrop();

  const handoff = prepareHandoff({
    busy: isPipelineSlotBusy(activityJob) || isPipelineSlotBusy(pipelineJob),
    pendingReviewCount: project?.edit_impact.pending_review_count ?? 0,
  });
  return (
    <PrepareStageView
      shell={shell}
      state={hostStateOf(project, loadFailure)}
      failure={loadFailure}
      empty={project != null && project.tracks.length === 0}
      canIngest={canIngestMedia(projectPath, guestMode, shareCapabilities)}
      importShortcut={displayShortcutFor("media.import") ?? null}
      handoff={handoff}
      dropTarget={<EmptySession drop={drop} />}
      pipeline={<PipelinePanel />}
      scrollRef={scrollRef}
      onImport={() => runPointerCommand("media.import", {})}
      onRecord={() => runPointerCommand("stage.record")}
      onHandoff={() => runPointerCommand(`stage.${handoff.target}`)}
    />
  );
}

/**
 * The Prepare stage host: import entry points, the pipeline panel and the
 * hand-off to Review or Edit. Host only; the frame never offers it to a guest.
 */
export const PrepareStage = memo(PrepareStageAdapter);
