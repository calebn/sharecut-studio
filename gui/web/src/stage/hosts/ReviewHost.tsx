import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import { ModelGateDialog } from "../../models";
import { ReviewStage } from "../../review/ReviewStage";
import { isGuestSession, isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";

import { GuestScriptHost } from "./GuestScriptHost";
import { hostStateOf } from "./hostModels";
import { ReviewStageView } from "./ReviewStageView";
import { useFindMore } from "./useFindMore";
import { useReviewQueue } from "./useReviewQueue";

export type ReviewHostProps = {
  guestShare?: boolean;
  loadFailure?: LoadFailure | null;
};

function panelFor(
  queue: ReturnType<typeof useReviewQueue>,
  find: ReturnType<typeof useFindMore>,
  scripted: boolean,
) {
  return (
    <>
      {scripted ? <GuestScriptHost /> : null}
      <ReviewStage
        {...queue.stageProps}
        job={find.job}
        onFindMore={find.onFindMore}
        findMoreDisabled={find.findMoreDisabled}
      />
    </>
  );
}

function ReviewHostAdapter({
  guestShare = false,
  loadFailure,
}: ReviewHostProps) {
  const queue = useReviewQueue(guestShare);
  const { project, projectPath, guestMode } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
    })),
  );
  const guest = isGuestSession(projectPath, guestMode, guestShare);
  const find = useFindMore(!guest && !isShareProjectKey(projectPath));
  const shell = useViewportClass();
  const scrollRef = useStageScroll("review", "section:queue");
  return (
    <>
      <ReviewStageView
        shell={shell}
        state={hostStateOf(project, loadFailure)}
        failure={loadFailure}
        panel={panelFor(
          queue,
          find,
          guest && project?.meta.hydration?.transcript_words !== false,
        )}
        onDeliver={guest ? undefined : () => runPointerCommand("stage.deliver")}
        scrollRef={scrollRef}
      />
      <ModelGateDialog gate={find.gate} />
    </>
  );
}

/**
 * The Review stage host: the Queue alone, where comments are items and the
 * comment field opens. A guest gets the Queue as a reader (`guest`): comments
 * only, and nothing that decides, because the queue acts on the project.
 */
export const ReviewHost = memo(ReviewHostAdapter);
