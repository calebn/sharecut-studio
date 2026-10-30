import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import { ModelGateDialog } from "../../models";
import { ReviewStage } from "../../review/ReviewStage";
import { isGuestSession, isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";

import { GuestScriptHost } from "./GuestScriptHost";
import { effectiveSection, hostStateOf, reviewSectionsFor } from "./hostModels";
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
  const { project, projectPath, guestMode, reviewSection } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      reviewSection: s.reviewSection,
    })),
  );
  const role = stageRoleOf(guestMode);
  const guest = isGuestSession(projectPath, guestMode, guestShare);
  const find = useFindMore(!guest && !isShareProjectKey(projectPath));
  const shell = useViewportClass();
  const sections = useMemo(() => reviewSectionsFor(role), [role]);
  const active = effectiveSection(reviewSection, sections);
  const scrollRef = useStageScroll("review", `section:${active}`);
  const waiting = {
    queue: (project?.edit_impact.pending_review_count ?? 0) > 0,
  };
  return (
    <>
      <ReviewStageView
        shell={shell}
        state={hostStateOf(project, loadFailure)}
        failure={loadFailure}
        sections={sections}
        active={active}
        waiting={waiting}
        onSection={(section) => runPointerCommand("stage.review", { section })}
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
