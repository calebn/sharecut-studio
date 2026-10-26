import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useViewportClass } from "../../hooks/useViewportClass";
import { CommentsPanel } from "../../panels/CommentsPanel";
import { ImpactPanel } from "../../panels/ImpactPanel";
import { TightenPanel } from "../../panels/TightenPanel";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import type { ReviewSection } from "../../types/stage";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";

import { effectiveSection, hostStateOf, reviewSectionsFor } from "./hostModels";
import { ReviewStageView } from "./ReviewStageView";

export type ReviewStageProps = {
  guestShare?: boolean;
  loadFailure?: LoadFailure | null;
};

function panelFor(section: ReviewSection, guestShare: boolean) {
  switch (section) {
    case "impact":
      return <ImpactPanel />;
    case "tighten":
      return <TightenPanel />;
    case "comments":
      return <CommentsPanel guestShare={guestShare} />;
  }
}

function ReviewStageAdapter({
  guestShare = false,
  loadFailure,
}: ReviewStageProps) {
  const { project, guestMode, reviewSection, setReviewSection, openStage } =
    useDawStore(
      useShallow((s) => ({
        project: s.project,
        guestMode: s.guestMode,
        reviewSection: s.reviewSection,
        setReviewSection: s.setReviewSection,
        openStage: s.openStage,
      })),
    );
  const role = stageRoleOf(guestMode);
  const shell = useViewportClass();
  const sections = useMemo(() => reviewSectionsFor(role), [role]);
  const active = effectiveSection(reviewSection, sections);
  const scrollRef = useStageScroll("review", `section:${active}`);
  const waiting = {
    impact: (project?.edit_impact.pending_review_count ?? 0) > 0,
    comments: project?.comments?.some((c) => !c.resolved) ?? false,
  };
  return (
    <ReviewStageView
      shell={shell}
      state={hostStateOf(project, loadFailure)}
      failure={loadFailure}
      sections={sections}
      active={active}
      waiting={waiting}
      onSection={setReviewSection}
      panel={panelFor(active, guestShare)}
      onDeliver={role === "host" ? () => openStage("deliver") : undefined}
      scrollRef={scrollRef}
    />
  );
}

/**
 * The Review stage host: Impact, Comments and Tighten sections. A guest sees
 * Comments only, because the others act on the project.
 */
export const ReviewStage = memo(ReviewStageAdapter);
