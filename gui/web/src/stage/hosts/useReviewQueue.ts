import { useEffect, useMemo, useRef, useState } from "react";
import {
  applySuggestedActions,
  approveEdits,
  loadTranscriptCheck,
  markTranscriptChecked,
  rejectEdits,
  waiveTranscriptRefine,
} from "../../api";
import { REVIEW_AUDITION_PAD_SEC } from "../../api/pendingPreview";
import { playPendingPreview } from "../../audio/pendingPreview";
import { runPointerCommand } from "../../commands/pointer";
import { refreshDocumentProject } from "../../document/applyDocumentUpdate";
import { REFINE_GATE_GUI_MESSAGE } from "../../inspector/TranscriptRefineRecovery";
import type { ReviewIntent } from "../../review/ReviewStage";
import {
  CHECK_ID,
  checkEntryOf,
  editIdOf,
  type ReviewEntry,
  reviewEntriesOf,
  reviewIdOf,
} from "../../review/reviewItems";
import { verbOf } from "../../review/reviewQueueModel";
import { useReviewSession } from "../../review/reviewSession";
import { isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { AuditionSide } from "../../system/auditionWindow";
import type {
  HistoryEntryId,
  TranscriptCheckStatus,
} from "../../types/project";
import {
  ApiError,
  errorMessage,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../../utils/apiError";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../../utils/pendingEditLabels";
import {
  bulkReviewHeldMessage,
  type HeldCut,
} from "../../utils/pendingReviewPass";
import { useStableCallback } from "../../utils/useStableCallback";

const WAIVE_NOTE = "Approved after listening in Review";
const CLOSER_LOOK = "Needs a closer look in Edit";
const CUT_AGAIN = "The transcript isn't checked yet. Cut again to cut anyway.";

type Reply = {
  queued: boolean;
  count: number | null;
  historyHead: HistoryEntryId | null;
  held?: readonly HeldCut[];
};

export function useReviewQueue() {
  const { project, projectPath, shell } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    shell: s.shellBreakpoint,
  }));
  const [status, setStatus] = useState<TranscriptCheckStatus | null>(null);
  const [held, setHeld] = useState<ReadonlyMap<string, string>>(new Map());
  const stageRef = useRef<HTMLDivElement>(null);
  const requests = useRef(0);
  const pending = project?.pending_edits;

  const refreshStatus = useStableCallback(async () => {
    if (isShareProjectKey(projectPath)) return null;
    const mine = ++requests.current;
    const next = await loadTranscriptCheck(projectPath).catch(() => null);
    if (next && mine === requests.current) setStatus(next);
    return next;
  });
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, projectPath]);
  useEffect(() => {
    const listed = new Set((pending ?? []).map((e) => reviewIdOf(e.id)));
    setHeld((prev) =>
      [...prev.keys()].every((id) => listed.has(id))
        ? prev
        : new Map([...prev].filter(([id]) => listed.has(id))),
    );
  }, [pending]);

  const open = useMemo<ReviewEntry[]>(() => {
    const entries = reviewEntriesOf(pending ?? []).map(({ item, content }) => {
      const why = held.get(item.id);
      return why === undefined
        ? { item, content }
        : {
            item: { ...item, blocked: true },
            content: { ...content, card: { ...content.card, why } },
          };
    });
    const check = status && checkEntryOf(status);
    return check ? [...entries, check] : entries;
  }, [pending, held, status]);
  const session = useReviewSession(open);

  const send = async (path: string, intent: ReviewIntent, ids: string[]) => {
    if (intent.waive)
      await waiveTranscriptRefine(path, intent.waive.note || WAIVE_NOTE);
    if (intent.result === "kept")
      return ids.length ? rejectEdits(path, ids) : null;
    if (ids.length === 0) return void (await markTranscriptChecked(path));
    const item = session.props.items.find((i) => i.id === intent.ids[0]);
    if (ids.length === 1 && item && verbOf(item) === "lower")
      return { ...(await applySuggestedActions(path, ids)), count: null };
    return approveEdits(
      path,
      ids,
      true,
      true,
      ids.length > 1 ? { skipUnsure: true } : undefined,
    );
  };

  const onDecide = useStableCallback(async (intent: ReviewIntent) => {
    const plan = session.decide(intent);
    if (!plan) return;
    const { projectPath: path, projectEpoch: epoch } = useDawStore.getState();
    const { announceStatus: say } = useDawStore.getState();
    const current = () => {
      const s = useDawStore.getState();
      return s.projectPath === path && s.projectEpoch === epoch;
    };
    const ids = plan.decidedIds.flatMap((id) => editIdOf(id) ?? []);
    try {
      const reply: Reply | void | null = await send(path, intent, ids);
      if (!current()) return;
      if (intent.waive || plan.decidedIds.includes(CHECK_ID))
        void refreshStatus();
      if (!reply) return say(plan.message);
      if (reply.queued) return say(PENDING_REVIEW_QUEUED_MESSAGE);
      const heldCuts = [...(reply.held ?? [])];
      const left = ids.length - heldCuts.length;
      if (
        intent.result === "applied" &&
        (reply.count === null || reply.count < left)
      ) {
        const fresh = await refreshDocumentProject(path).catch(() => null);
        if (!current()) return;
        const waiting = new Set(heldCuts.map((h) => h.id));
        for (const edit of fresh?.pending_edits ?? []) {
          if (
            ids.includes(edit.id) &&
            !waiting.has(edit.id) &&
            !edit.applied &&
            edit.review_required
          )
            heldCuts.push({
              id: edit.id,
              label: edit.label ?? "A suggestion",
              reason: CLOSER_LOOK,
            });
        }
        if (!fresh)
          for (const id of ids)
            if (!waiting.has(id))
              heldCuts.push({ id, label: "A suggestion", reason: CLOSER_LOOK });
      }
      if (heldCuts.length) {
        setHeld(
          (prev) =>
            new Map([
              ...prev,
              ...heldCuts.map((h): [string, string] => [
                reviewIdOf(h.id),
                h.reason,
              ]),
            ]),
        );
        session.revert(heldCuts.map((h) => reviewIdOf(h.id)));
      }
      say(
        heldCuts.length
          ? bulkReviewHeldMessage(
              reply.count ?? ids.length - heldCuts.length,
              heldCuts,
            )
          : plan.message,
        {
          undo: reply.historyHead,
          onUndone: () => {
            session.revert(plan.decidedIds);
            stageRef.current?.focus({ preventScroll: true });
          },
          returnFocus: () => stageRef.current,
        },
      );
    } catch (error) {
      session.revert(plan.decidedIds);
      if (!current()) return;
      const gate =
        error instanceof ApiError &&
        error.code === TRANSCRIPT_REFINE_REQUIRED_CODE;
      if (gate && !intent.waive) {
        const next = await refreshStatus();
        if (current() && next && checkEntryOf(next)) return say(CUT_AGAIN);
      }
      say(gate ? REFINE_GATE_GUI_MESSAGE : errorMessage(error), {
        tone: "error",
      });
    }
  });

  const onHear = useStableCallback(async (id: string, side: AuditionSide) => {
    const editId = editIdOf(id);
    if (!editId) return;
    const mode = side === "A" ? "current" : "suggested";
    const outcome = await playPendingPreview(projectPath, editId, mode, {
      padSec: REVIEW_AUDITION_PAD_SEC,
    });
    if (outcome.status === "disabled")
      useDawStore.getState().announceStatus(outcome.reason);
  });

  const onOpenInEdit = useStableCallback((id: string) => {
    const editId = editIdOf(id);
    const edit = pending?.find((e) => e.id === editId);
    if (!editId || !edit) return;
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: editId, trackId: edit.track_id });
    void runPointerCommand("stage.edit");
  });

  return {
    stageProps: {
      ...session.props,
      ref: stageRef,
      duration: project?.timeline_duration_sec ?? 0,
      layout: shell === "phone" ? ("phone" as const) : ("desktop" as const),
      onDecide,
      onHear,
      onOpenInEdit,
      onHandOff: () => void runPointerCommand("stage.deliver"),
    },
  };
}
