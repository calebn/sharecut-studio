import { useMemo, useRef, useState } from "react";
import {
  type ReviewIntent,
  ReviewStage,
  type ReviewStageProps,
} from "../review/ReviewStage";
import type { ReviewEntry } from "../review/reviewItems";
import type { ReviewFilter, ReviewItem } from "../review/reviewQueueModel";
import {
  type SessionStageProps,
  useReviewSession,
} from "../review/reviewSession";
import { KIND_META } from "../system/decisionKinds";
import type { SystemIconName } from "../system/icons";
import { SystemIcon } from "../system/SystemIcon";
import { iconOf } from "../system/verbDisplay";
import { Toast } from "../ui";

export type ReviewStageHarnessProps = Omit<
  ReviewStageProps,
  Exclude<keyof SessionStageProps, "content"> | "ref" | "onDecide"
> & {
  initialItems: readonly ReviewItem[];
  initialSelectedId?: string;
  initialFilter?: ReviewFilter;
  toastMs?: number;
  onDecide?: (intent: ReviewIntent) => void;
};

type Shown = {
  id: number;
  message: string;
  ids: readonly string[];
  icon: SystemIconName;
};

/** Story and test host: `useReviewSession` over fixtures plus the Undo toast. Never imported by app code. */
export function ReviewStageHarness({
  initialItems,
  initialSelectedId,
  initialFilter,
  toastMs = 6000,
  content,
  onDecide,
  ...stage
}: ReviewStageHarnessProps) {
  const open = useMemo<ReviewEntry[]>(
    () => initialItems.map((item) => ({ item, content: content(item) })),
    [initialItems, content],
  );
  const session = useReviewSession(open, {
    selectedId: initialSelectedId,
    filter: initialFilter,
  });
  const stageRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<Shown | null>(null);

  const decide = (intent: ReviewIntent) => {
    onDecide?.(intent);
    const plan = session.decide(intent);
    if (!plan) return;
    const first = session.props.items.find((i) => i.id === intent.ids[0]);
    setToast({
      id: Date.now(),
      message: plan.message,
      ids: plan.decidedIds,
      icon: iconOf(
        intent.result === "kept" || !first
          ? "keep"
          : KIND_META[first.kind].verb,
      ),
    });
  };

  return (
    <>
      <ReviewStage
        {...stage}
        {...session.props}
        ref={stageRef}
        onDecide={decide}
      />
      <Toast
        className="sys-toast-dock"
        toast={toast}
        timeoutMs={toastMs}
        icon={toast ? <SystemIcon name={toast.icon} size={16} /> : undefined}
        onUndo={
          toast
            ? () => {
                session.revert(toast.ids);
                setToast(null);
                stageRef.current?.focus();
              }
            : undefined
        }
        onDismiss={() => setToast(null)}
      />
    </>
  );
}
