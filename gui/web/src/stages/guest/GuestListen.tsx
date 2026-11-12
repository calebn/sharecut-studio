import { type ReactNode, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { type ReviewContent, ReviewQueue } from "../../review/ReviewQueue";
import type { ReviewStageProps } from "../../review/ReviewStage";
import type { ReviewItem } from "../../review/reviewQueueModel";
import { ChaptersList } from "../../stage/frame/ChaptersList";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { Cover } from "../../system/Cover";
import { DecisionCard } from "../../system/DecisionCard";
import { Sheet } from "../../system/Sheet";
import type { DrawerDetent } from "../../ui/BottomSheet";
import { CommentsRow, type CommentsRowPreview } from "./CommentsRow";
import {
  type ListenInput,
  type ListenRole,
  listenLayoutOf,
  nearestBefore,
} from "./listenLayout";

/** How far back from the playhead a comment still counts as the one being heard. */
const PREVIEW_WINDOW_SEC = 15;

export type GuestListenProps = {
  /** `useReviewQueue(guest).stageProps`: the items, the selection, the thread and the composer. */
  review: ReviewStageProps;
  /** The Script, or the Skeleton or Cover that stands in for it. */
  script: ReactNode;
  /** The transcript's real state; it decides whether the middle is the Script. */
  scriptState: ListenInput["script"];
};

function previewOf(
  item: ReviewItem,
  content: (item: ReviewItem) => ReviewContent,
): CommentsRowPreview {
  const { row } = content(item);
  return {
    author: row.author?.name ?? "",
    time: row.time ?? "",
    text: typeof row.snippet === "string" ? row.snippet : "",
  };
}

/**
 * The phone Viewer and Commenter body on Review. The Player's dock sits under
 * it. What fills the middle and what sits above the dock come from
 * `listenLayoutOf`; to add a surface above the dock, add a `ListenBottom`
 * variant, not a boolean. The Comments sheet lives here because it needs the
 * queue's state.
 */
export function GuestListen({ review, script, scriptState }: GuestListenProps) {
  const { role, draft, openSheet, setOpenSheet, projectName, hasChapters } =
    useDawStore(
      useShallow((s) => ({
        role: stageRoleOf(s.guestMode),
        draft: s.commentDraft,
        openSheet: s.openSheet,
        setOpenSheet: s.setOpenSheet,
        projectName: s.project?.meta.name ?? "",
        hasChapters: (s.project?.chapters.length ?? 0) > 0,
      })),
    );
  const listenRole: ListenRole = role === "viewer" ? "viewer" : "commenter";
  const { items, content, selectedId } = review;
  const commentItems = useMemo(
    () => items.filter((item) => item.kind === "comment"),
    [items],
  );
  const layout = listenLayoutOf({
    role: listenRole,
    script: scriptState,
    counts: {
      comments: commentItems.length,
      suggestions: items.length - commentItems.length,
    },
    hasChapters,
    draft,
  });
  useKeyboardInset(layout.bottom.kind === "composer");

  const heardId = useDawStore(
    (s) =>
      nearestBefore(commentItems, s.playheadSec, PREVIEW_WINDOW_SEC)?.id ??
      null,
  );
  const heard = items.find((item) => item.id === heardId);
  const [step, setStep] = useState<string | null>(null);
  const [detent, setDetent] = useState<DrawerDetent>("half");
  const stepItem = step ? items.find((item) => item.id === step) : undefined;
  const close = () => {
    setStep(null);
    setOpenSheet(null);
  };
  const open = (id: string | null) => {
    if (id) {
      review.onSelect(id);
      setStep(id);
    }
    setOpenSheet("comments");
  };

  const middle =
    layout.middle.kind === "script" ? (
      script
    ) : layout.middle.kind === "chapters" ? (
      <ChaptersList />
    ) : (
      <Cover size="region" glyph="headphones" title={projectName}>
        Press play to listen.
      </Cover>
    );
  const { bottom } = layout;
  const card = stepItem ? content(stepItem).card : null;

  return (
    <div className="gl" data-bottom={bottom.kind}>
      <div className="gl-middle">{middle}</div>
      {bottom.kind === "row" ? (
        <CommentsRow
          label={bottom.label}
          comments={bottom.comments}
          preview={heard ? previewOf(heard, content) : undefined}
          onOpen={() => open(heardId)}
        />
      ) : bottom.kind === "composer" ? (
        review.composer
      ) : null}
      <Sheet
        form="bottom"
        title="Comments"
        open={openSheet === "comments"}
        detent={detent}
        onDetentChange={setDetent}
        onClose={close}
        step={
          stepItem && card
            ? {
                title: card.title,
                onBack: () => setStep(null),
                children: (
                  <DecisionCard
                    kind={stepItem.kind}
                    state="ready"
                    title={card.title}
                    time={card.time}
                    speaker={card.speaker}
                    suggestedBy={card.suggestedBy}
                    excerpt={card.excerpt}
                    comment={card.comment}
                    why={card.why}
                    thread={review.thread?.(stepItem)}
                    readOnly
                    canEdit={false}
                    layout="phone"
                  />
                ),
              }
            : null
        }
      >
        <ReviewQueue
          items={items}
          content={content}
          selectedId={selectedId}
          filter={review.filter}
          speaker={review.speaker}
          sort={review.sort}
          guest
          canDecide={false}
          detailKind={review.wordDetail?.kind}
          attention={review.attention}
          state={review.state}
          onFilter={review.onFilter}
          onSort={review.onSort}
          onSelect={(id) => open(id)}
          onRetry={review.onRetry}
        />
      </Sheet>
    </div>
  );
}
