import { memo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useShortViewport } from "../../hooks/useShortViewport";
import { useViewportClass } from "../../hooks/useViewportClass";
import { ReviewStage } from "../../review/ReviewStage";
import { undecidedOf } from "../../review/reviewQueueModel";
import { isGuestSession, isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { GuestPlayerCard } from "../frame/GuestPlayerCard";
import { guestPlayerCardShown } from "../frame/guestPlayerCardShown";
import { useStageScroll } from "../useStageScroll";

import { GuestScriptHost } from "./GuestScriptHost";
import { LoadFailureCover } from "./HostBody";
import { hostStateOf, type LoadFailure } from "./hostModels";
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
  card: boolean,
  failure: ReactNode,
) {
  // Guest on a wide shell: Player card, composer, transcript in one column.
  // Otherwise the transcript sits above the Queue; a load failure takes the
  // transcript's place (guest) or the queue's (host), never the whole body.
  const script = scripted ? <GuestScriptHost /> : null;
  return (
    <>
      {card ? null : failure && scripted ? failure : script}
      <ReviewStage
        {...queue.stageProps}
        job={find.job}
        onFindMore={find.onFindMore}
        findMoreDisabled={find.findMoreDisabled}
        centerTop={card ? <GuestPlayerCard /> : undefined}
        centerBottom={card ? script : undefined}
        regionFailure={failure && (card || !scripted) ? failure : undefined}
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
  const short = useShortViewport();
  const scrollRef = useStageScroll("review", "section:queue");
  return (
    <ReviewStageView
      shell={shell}
      state={hostStateOf(project, loadFailure)}
      failure={loadFailure}
      panel={panelFor(
        queue,
        find,
        guest &&
          (loadFailure != null ||
            project?.meta.hydration?.transcript_words !== false),
        guestPlayerCardShown("review", shell, guest, short),
        loadFailure ? (
          <LoadFailureCover stage="review" failure={loadFailure} />
        ) : null,
      )}
      onDeliver={guest ? undefined : () => runPointerCommand("stage.deliver")}
      undecided={undecidedOf(queue.stageProps.items)}
      scrollRef={scrollRef}
    />
  );
}

/**
 * The Review stage host: the Queue alone, where comments are items and the
 * comment field opens. A guest gets the Queue as a reader (`guest`): comments
 * only, and nothing that decides, because the queue acts on the project.
 */
export const ReviewHost = memo(ReviewHostAdapter);
