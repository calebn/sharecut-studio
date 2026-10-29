import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import { ModelGateDialog } from "../../models";
import { CommentsPanel } from "../../panels/CommentsPanel";
import { ReviewStage } from "../../review/ReviewStage";
import { isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import type { ReviewSection } from "../../types/stage";
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
  section: ReviewSection,
  guestShare: boolean,
  queue: ReturnType<typeof useReviewQueue>,
  find: ReturnType<typeof useFindMore>,
  guest: boolean,
) {
  switch (section) {
    case "queue":
      return (
        <ReviewStage
          {...queue.stageProps}
          job={find.job}
          onFindMore={find.onFindMore}
          findMoreDisabled={find.findMoreDisabled}
        />
      );
    case "comments":
      return (
        <>
          {guest ? <GuestScriptHost /> : null}
          <CommentsPanel guestShare={guestShare} />
        </>
      );
  }
}

function ReviewHostAdapter({
  guestShare = false,
  loadFailure,
}: ReviewHostProps) {
  const queue = useReviewQueue();
  const { project, projectPath, guestMode, reviewSection } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      reviewSection: s.reviewSection,
    })),
  );
  const role = stageRoleOf(guestMode);
  const find = useFindMore(role === "host" && !isShareProjectKey(projectPath));
  const shell = useViewportClass();
  const sections = useMemo(() => reviewSectionsFor(role), [role]);
  const active = effectiveSection(reviewSection, sections);
  const scrollRef = useStageScroll("review", `section:${active}`);
  const waiting = {
    queue: (project?.edit_impact.pending_review_count ?? 0) > 0,
    comments: project?.comments?.some((c) => !c.resolved) ?? false,
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
          active,
          guestShare,
          queue,
          find,
          role !== "host" &&
            project?.meta.hydration?.transcript_words !== false,
        )}
        onDeliver={
          role === "host" ? () => runPointerCommand("stage.deliver") : undefined
        }
        scrollRef={scrollRef}
      />
      <ModelGateDialog gate={find.gate} />
    </>
  );
}

/**
 * The Review stage host: Queue and Comments sections. A guest sees
 * Comments only, because the others act on the project.
 */
export const ReviewHost = memo(ReviewHostAdapter);
