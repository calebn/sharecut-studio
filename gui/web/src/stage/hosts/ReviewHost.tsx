import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { dispatchComposer } from "../../commands/composer";
import { runPointerCommand } from "../../commands/pointer";
import { transcriptGrantOf } from "../../document/shownTranscript";
import { useTranscriptDetail } from "../../document/useTranscriptDetail";
import { useShortViewport } from "../../hooks/useShortViewport";
import { useViewportClass } from "../../hooks/useViewportClass";
import { ReviewStage } from "../../review/ReviewStage";
import { reviewCompletenessOf } from "../../review/reviewCompleteness";
import { isGuestSession, isShareProjectKey } from "../../shareMode";
import { GuestListen } from "../../stages/guest/GuestListen";
import { listenScriptOf } from "../../stages/guest/listenLayout";
import { useGuestReading } from "../../stages/guest/useGuestReading";
import { useDawStore } from "../../state/dawStore";
import { listenLayoutOf, stageRoleOf } from "../../state/stageRoutes";
import { Skeleton } from "../../system/Skeleton";
import { GuestPlayerCard } from "../frame/GuestPlayerCard";
import { playerPlacementOf } from "../frame/playerPlacement";
import { useStageScroll } from "../useStageScroll";
import { GuestScriptHost } from "./GuestScriptHost";
import { GuestSelectionMemory } from "./guestSelection";
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
  detailRegion: ReactNode,
  script: ReactNode,
) {
  // Guest on a wide shell: Player card, composer, transcript in one column.
  // Otherwise the transcript sits above the Queue; a load failure takes the
  // transcript's place (guest) or the queue's (host), never the whole body.
  return (
    <>
      {card ? null : (detailRegion ?? (failure && scripted ? failure : script))}
      <ReviewStage
        {...queue.stageProps}
        job={find.job}
        onFindMore={find.onFindMore}
        findMoreDisabled={find.findMoreDisabled}
        centerTop={card ? <GuestPlayerCard /> : undefined}
        centerBottom={card ? (detailRegion ?? script) : undefined}
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
  const completeness = reviewCompletenessOf(
    queue.stageProps.items,
    queue.stageProps.wordDetail?.kind,
  );
  const { project, projectPath, projectEpoch, guestMode, transcriptGrant } =
    useDawStore(
      useShallow((s) => ({
        project: s.project,
        projectPath: s.projectPath,
        projectEpoch: s.projectEpoch,
        guestMode: s.guestMode,
        transcriptGrant: transcriptGrantOf(s),
      })),
    );
  const guest = isGuestSession(projectPath, guestMode, guestShare);
  const find = useFindMore(!guest && !isShareProjectKey(projectPath));
  const detail = useTranscriptDetail();
  const shell = useViewportClass();
  const short = useShortViewport();
  const placement = playerPlacementOf({
    stage: "review",
    shell,
    role: stageRoleOf(guestMode),
    short,
  });
  const listening = listenLayoutOf(shell, guestMode);
  useLayoutEffect(() => {
    dispatchComposer({ type: "layout", listen: listening });
  }, [listening]);
  // The dock reads the same fact, so its Chapters button agrees with the middle.
  const loadFailed = loadFailure != null;
  useEffect(() => {
    useDawStore.getState().setListenLoadFailed(loadFailed);
    return () => useDawStore.getState().setListenLoadFailed(false);
  }, [loadFailed]);
  const scrollRef = useStageScroll("review", "section:queue");
  const selectionScope = useMemo(() => {
    const memory = new GuestSelectionMemory();
    return { transcriptGrant, projectEpoch, guestMode, memory };
  }, [transcriptGrant, projectEpoch, guestMode]);
  useLayoutEffect(
    () => () => {
      const state = useDawStore.getState();
      if (
        transcriptGrantOf(state) === selectionScope.transcriptGrant &&
        state.projectEpoch === selectionScope.projectEpoch &&
        state.guestMode === selectionScope.guestMode
      )
        return;
      const mine = selectionScope.memory.get();
      selectionScope.memory.set(null);
      if (mine && state.selection === mine.stored) state.setSelection(null);
    },
    [selectionScope],
  );
  const reading = useGuestReading();
  // The Listen layout keeps the transcript at any height, the keyboard's included.
  const roomForScript = listening || !short;
  const detailFailure =
    guest && !loadFailure && roomForScript && detail.kind === "failed" ? (
      <LoadFailureCover
        stage="review"
        focusIfLost
        failure={{
          source: "detail",
          onRetry: detail.retry,
          recovering: detail.recovering,
        }}
      />
    ) : null;
  const detailLoading =
    guest && !loadFailure && roomForScript && detail.kind === "pending" ? (
      <Skeleton rows={1} onRetry={detail.retry} />
    ) : null;
  const detailRegion = detailFailure ?? detailLoading;
  const failure = loadFailure ? (
    <LoadFailureCover stage="review" failure={loadFailure} />
  ) : null;
  const feedback = detailRegion ? (
    <div className="stage-host-guest-feedback">{detailRegion}</div>
  ) : null;
  const scripted = guest && (loadFailure != null || detail.kind === "ready");
  const script =
    scripted && detail.kind === "ready" ? (
      <GuestScriptHost
        reading={reading}
        selectionMemory={selectionScope.memory}
        shown={detail.shown}
      />
    ) : null;
  const panel = listening ? (
    <GuestListen
      review={queue.stageProps}
      scriptState={listenScriptOf({
        loadFailed,
        detail: detail.kind,
        hasTranscript: (project?.transcript?.utterances?.length ?? 0) > 0,
      })}
      script={feedback ?? failure ?? script}
    />
  ) : (
    panelFor(
      queue,
      find,
      scripted,
      placement === "card",
      failure,
      feedback,
      script,
    )
  );
  return (
    <ReviewStageView
      shell={shell}
      state={hostStateOf(project, loadFailure)}
      failure={loadFailure}
      panel={panel}
      onDeliver={guest ? undefined : () => runPointerCommand("stage.deliver")}
      undecided={completeness.undecided}
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
