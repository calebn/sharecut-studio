import { useEffect, useMemo, useRef, useState } from "react";
import {
  applySuggestedActions,
  approveEdits,
  correctTranscriptWord,
  loadTranscriptCheck,
  markTranscriptChecked,
  rejectEdits,
  waiveTranscriptRefine,
} from "../../api";
import { playPendingPreview } from "../../audio/pendingPreview";
import { runPointerCommand } from "../../commands/pointer";
import { refreshDocumentProject } from "../../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../../document/cursor";
import { REFINE_GATE_GUI_MESSAGE } from "../../inspector/TranscriptRefineRecovery";
import type { BulkProgress } from "../../review/ReviewQueue";
import type { ReviewIntent } from "../../review/ReviewStage";
import {
  CHECK_ID,
  checkEntryOf,
  commentItemId,
  editIdOf,
  type ReviewEntry,
  reviewEntriesOf,
  reviewIdOf,
  unsureEntriesOf,
  type WordTarget,
  wordIdOf,
} from "../../review/reviewItems";
import { kindInFilter, verbOf } from "../../review/reviewQueueModel";
import { useReviewSession } from "../../review/reviewSession";
import { commentRole, isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { AuditionSide } from "../../system/auditionWindow";
import type {
  HistoryEntryId,
  PendingEditView,
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
  heldReasonText,
} from "../../utils/pendingReviewPass";
import { playTimelineRange } from "../../utils/playRange";
import { useStableCallback } from "../../utils/useStableCallback";
import { useReviewComments } from "./useReviewComments";

const WAIVE_NOTE = "Approved after listening in Review";
const CHANGED_MESSAGE =
  "The transcript changed after you reviewed it. Review it again, then mark it checked.";
const changedMessage = (error: unknown) =>
  error instanceof ApiError && error.code === "transcript_changed"
    ? CHANGED_MESSAGE
    : undefined;
const CLOSER_LOOK = "Needs a closer look in Edit";
const UNSURE_REASON = "unsure_word";
const HEAR_PAD_SEC = 2;
const OPEN_CHECK =
  "The transcript check stays open until every word has loaded.";
const LEFT_AS_IS = "Left as it is. Nobody is talking over it.";
const RELOAD_FAILED =
  "Undone, but the words did not reload. Reload the project to see them.";
const CUT_AGAIN = "The transcript isn't checked yet. Cut again to cut anyway.";

const rangeOf = (e: PendingEditView) =>
  JSON.stringify([e.timeline_start, e.timeline_end, e.timeline_spans]);

type Held = { reason: string; range: string };

type Reply = {
  queued: boolean;
  count: number | null;
  historyHead: HistoryEntryId | null;
  held?: readonly HeldCut[];
  loweredToLeave?: number;
};

export function useReviewQueue() {
  const { project, projectPath, shell, guestMode, picked } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    shell: s.shellBreakpoint,
    guestMode: s.guestMode,
    picked: s.selection?.kind === "comment" ? s.selection : null,
  }));
  const comments = useReviewComments(
    commentRole(projectPath, guestMode) === "host",
  );
  const [status, setStatus] = useState<TranscriptCheckStatus | null>(null);
  const [bulkRunning, setBulkRunning] = useState<BulkProgress | null>(null);
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const settled = useRef(
    new Map<string, { head: HistoryEntryId; seq: number }>(),
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const requests = useRef(0);
  const confirmed = useRef(new Set<string>());
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
    const ranges = new Map(
      (pending ?? []).map((e) => [reviewIdOf(e.id), rangeOf(e)]),
    );
    const resolved = new Set(
      (pending ?? [])
        .filter((e) => !e.unsure_words?.length)
        .map((e) => reviewIdOf(e.id)),
    );
    setHeld((prev) => {
      const kept = [...prev].filter(
        ([id, h]) =>
          ranges.get(id) === h.range &&
          !(h.reason === UNSURE_REASON && resolved.has(id)),
      );
      return kept.length === prev.size ? prev : new Map(kept);
    });
  }, [pending]);

  const utterances = project?.transcript?.utterances;
  const words = useMemo(
    () => unsureEntriesOf(pending ?? [], utterances ?? []),
    [pending, utterances],
  );
  const open = useMemo<ReviewEntry[]>(() => {
    const entries = reviewEntriesOf(pending ?? []).map(({ item, content }) => {
      const why = held.get(item.id)?.reason;
      return why === undefined || (why === UNSURE_REASON && !item.unsure)
        ? { item, content }
        : {
            item:
              why === UNSURE_REASON
                ? { ...item, unsure: true }
                : { ...item, blocked: true },
            content: {
              ...content,
              card: { ...content.card, why: heldReasonText(why) },
            },
          };
    });
    const check = status && checkEntryOf(status);
    return [
      ...entries,
      ...words.entries,
      ...(check ? [check] : []),
      ...comments.entries,
    ];
  }, [pending, held, status, words, comments.entries]);
  const session = useReviewSession(open);
  const { revert } = session;
  const select = useStableCallback(session.props.onSelect);
  const selected = useStableCallback(() => session.props.selectedId);
  const onFilter = useStableCallback(session.props.onFilter);
  const land = useStableCallback((id: string) => {
    if (open.find((e) => e.item.id === id)?.item.result) return;
    if (!kindInFilter("comment", session.props.filter)) onFilter("all");
    select(id);
  });
  useEffect(() => {
    if (picked) land(commentItemId(picked.id));
  }, [picked, land]);
  const head = project?.history.head_id;
  useEffect(() => {
    const listed = new Set(open.map((e) => e.item.id));
    const back = [...settled.current].filter(
      ([id, at]) =>
        listed.has(id) && at.head !== head && currentDocumentSeq() > at.seq,
    );
    for (const [id] of back) settled.current.delete(id);
    if (back.length) revert(back.map(([id]) => id));
  }, [open, head, revert]);

  const send = async (
    path: string,
    intent: ReviewIntent,
    ids: string[],
    word?: { target: WordTarget; text: string },
    check?: boolean,
    fingerprint?: string,
  ) => {
    if (intent.waive)
      await waiveTranscriptRefine(path, intent.waive.note || WAIVE_NOTE);
    if (word) {
      const { target, text } = word;
      const historyHead = await correctTranscriptWord(
        path,
        target.trackId,
        target.wordIndex,
        text,
        target.text,
        target.sourceId,
      );
      return { queued: false, count: null, historyHead } satisfies Reply;
    }
    if (ids.length === 0) {
      if (check) await markTranscriptChecked(path, undefined, fingerprint);
      return;
    }
    if (intent.result === "kept") return rejectEdits(path, ids);
    const item = session.props.items.find((i) => i.id === intent.ids[0]);
    if (ids.length === 1 && item && verbOf(item) === "lower") {
      const { held, loweredToLeave, ...rest } = await applySuggestedActions(
        path,
        ids,
      );
      return {
        ...rest,
        loweredToLeave,
        held: (held ?? []).map((id) => ({
          id,
          label:
            useDawStore
              .getState()
              .project?.pending_edits?.find((e) => e.id === id)?.label ??
            "A suggestion",
          reason: CLOSER_LOOK,
        })),
        count: null,
      };
    }
    return approveEdits(
      path,
      ids,
      true,
      true,
      intent.group || ids.length > 1 ? { skipUnsure: true } : undefined,
    );
  };

  const settleCheck = async (
    path: string,
    seen: TranscriptCheckStatus | null,
    closes: boolean,
    changed: boolean,
    complete: boolean,
  ): Promise<string | false | undefined> => {
    if (closes) {
      if (!complete) {
        revert([CHECK_ID]);
        return OPEN_CHECK;
      }
      try {
        const next = await markTranscriptChecked(
          path,
          undefined,
          (await loadTranscriptCheck(path)).fingerprint,
        );
        requests.current++;
        setStatus(next);
      } catch (error) {
        revert([CHECK_ID]);
        useDawStore
          .getState()
          .announceStatus(changedMessage(error) ?? errorMessage(error), {
            tone: "error",
          });
        return false;
      }
    } else if (changed && seen?.clear) {
      try {
        if (seen.status === "done")
          await markTranscriptChecked(
            path,
            undefined,
            (await loadTranscriptCheck(path)).fingerprint,
          );
        else if (seen.status === "waived")
          await waiveTranscriptRefine(path, seen.notes || WAIVE_NOTE);
      } catch (error) {
        return `The transcript check could not be kept. ${changedMessage(error) ?? "Mark it checked again."}`;
      }
    }
  };

  /** Marks the cuts a Fix frees and returns their ids, so Undo can hold exactly those. */
  const releaseCuts = (wordId: string) => {
    confirmed.current.add(wordId);
    const freed: string[] = [];
    for (const edit of useDawStore.getState().project?.pending_edits ?? []) {
      const unsure = edit.unsure_words ?? [];
      if (
        !edit.applied &&
        unsure.length &&
        unsure.every((w) =>
          confirmed.current.has(
            wordIdOf(w.track_id, w.source_id, w.word_index),
          ),
        )
      ) {
        const id = reviewIdOf(edit.id);
        session.props.onLooksRight(id);
        freed.push(id);
      }
    }
    return freed;
  };

  const onDecide = useStableCallback(async (intent: ReviewIntent) => {
    const plan = session.decide(intent);
    if (!plan) return;
    const back = (ids: readonly string[]) =>
      session.revert(ids, plan.selectedId);
    const { projectPath: path, projectEpoch: epoch } = useDawStore.getState();
    const { announceStatus: say } = useDawStore.getState();
    const ledger = () => useDawStore.getState().project?.pending_edits ?? [];
    const current = () => {
      const s = useDawStore.getState();
      return s.projectPath === path && s.projectEpoch === epoch;
    };
    const ids = plan.decidedIds.flatMap((id) => editIdOf(id) ?? []);
    const target = words.targets.get(intent.ids[0]);
    const text = intent.text?.trim() || target?.text || "";
    const changed = !!target && text !== target.text;
    const word = target && { target, text };
    const closes = plan.decidedIds.includes(CHECK_ID);
    const seen = status;
    const complete =
      useDawStore.getState().project?.meta?.hydration?.transcript_words !==
      false;
    const group = intent.group
      ? session.props.items.find((i) => i.id === intent.ids[0])
      : undefined;
    if (group) {
      setBulkRunning({
        kind: group.kind,
        total: ids.length,
        startedAtSec: Date.now() / 1000,
      });
      say(`Applying ${ids.length} changes…`);
    }
    const said =
      target && changed ? `Fixed “${target.text}” to “${text}”` : plan.message;
    try {
      const reply: Reply | void | null = await send(
        path,
        intent,
        ids,
        word,
        closes,
        seen?.fingerprint,
      );
      if (!current()) return;
      const freed = target ? releaseCuts(intent.ids[0]) : [];
      const marked = word
        ? await settleCheck(path, seen, closes, changed, complete)
        : undefined;
      const message = typeof marked === "string" ? `${said}. ${marked}` : said;
      if (intent.waive || closes || changed) void refreshStatus();
      if (!current()) return;
      if (marked === false) return false;
      if (!reply) return say(plan.message);
      if (reply.queued) return say(PENDING_REVIEW_QUEUED_MESSAGE);
      const heldCuts = [...(reply.held ?? [])];
      const left = ids.length - heldCuts.length;
      if (
        ids.length > 0 &&
        intent.result === "applied" &&
        (reply.count === null || reply.count < left)
      ) {
        await refreshDocumentProject(path).catch(() => null);
        if (!current()) return;
        for (const edit of ledger())
          if (
            ids.includes(edit.id) &&
            !heldCuts.some((h) => h.id === edit.id) &&
            !edit.applied &&
            edit.review_required
          )
            heldCuts.push({
              id: edit.id,
              label: edit.label ?? "A suggestion",
              reason: CLOSER_LOOK,
            });
      }
      if (heldCuts.length) {
        setHeld(
          (prev) =>
            new Map([
              ...prev,
              ...heldCuts.map((h): [string, Held] => {
                const edit = ledger().find((e) => e.id === h.id);
                return [
                  reviewIdOf(h.id),
                  { reason: h.reason, range: edit ? rangeOf(edit) : "" },
                ];
              }),
            ]),
        );
        back(heldCuts.map((h) => reviewIdOf(h.id)));
      }
      if (reply.historyHead)
        for (const id of ids)
          if (!heldCuts.some((h) => h.id === id))
            settled.current.set(reviewIdOf(id), {
              head: reply.historyHead,
              seq: currentDocumentSeq(),
            });
      say(
        heldCuts.length
          ? bulkReviewHeldMessage(
              reply.count ?? ids.length - heldCuts.length,
              heldCuts,
            )
          : reply.loweredToLeave
            ? LEFT_AS_IS
            : message,
        {
          undo: reply.historyHead,
          onUndone: () => {
            confirmed.current.delete(intent.ids[0]);
            session.revert(plan.decidedIds, undefined, freed);
            // A same-text Undo reply keeps the old timed words, so reload them.
            if (target && current())
              void refreshDocumentProject(path, "full").catch(() => {
                if (current()) say(RELOAD_FAILED, { tone: "error" });
              });
            if (closes || changed) void refreshStatus();
            stageRef.current?.focus({ preventScroll: true });
          },
          returnFocus: () => stageRef.current,
        },
      );
      return true;
    } catch (error) {
      back(plan.decidedIds);
      if (!current()) return false;
      const gate =
        error instanceof ApiError &&
        error.code === TRANSCRIPT_REFINE_REQUIRED_CODE;
      const changedText = changedMessage(error);
      const next =
        gate || intent.waive || changedText ? await refreshStatus() : null;
      if (!current()) return false;
      if (next && checkEntryOf(next) && !changedText && !intent.waive)
        say(CUT_AGAIN);
      else
        say(
          changedText ?? (gate ? REFINE_GATE_GUI_MESSAGE : errorMessage(error)),
          {
            tone: "error",
          },
        );
      return false;
    } finally {
      // One slot: ReviewStage.bulk() refuses to start while bulkRunning is set.
      if (group) setBulkRunning(null);
    }
  });

  const onHear = useStableCallback(async (id: string, side: AuditionSide) => {
    const word = words.targets.get(id);
    if (word) {
      const { at, endSec } = word;
      if (at === null)
        return useDawStore
          .getState()
          .announceStatus("This word is not on the timeline.", {
            tone: "error",
          });
      const { beginAudition, setPlayheadSec, setPlayUntilSec, setIsPlaying } =
        useDawStore.getState();
      return playTimelineRange({
        start: at,
        end: endSec ?? at,
        padSec: HEAR_PAD_SEC,
        beginAudition,
        setPlayheadSec,
        setPlayUntilSec,
        setIsPlaying,
      });
    }
    const editId = editIdOf(id);
    if (!editId) return;
    const mode = side === "A" ? "current" : "suggested";
    const outcome = await playPendingPreview(projectPath, editId, mode, {
      padSec: 3,
    });
    if (outcome.status === "disabled")
      useDawStore.getState().announceStatus(outcome.reason, { tone: "error" });
  });

  const onOpenInEdit = useStableCallback((id: string) => {
    const word = words.targets.get(id);
    if (word) {
      const state = useDawStore.getState();
      state.setSelection({
        kind: "transcriptRange",
        trackId: word.trackId,
        sourceId: word.sourceId,
        startWordIndex: word.wordIndex,
        endWordIndex: word.wordIndex,
      });
      if (word.at !== null) state.setPlayheadSec(word.at);
      return runPointerCommand("stage.edit");
    }
    const editId = editIdOf(id);
    const edit = pending?.find((e) => e.id === editId);
    if (!editId || !edit) return;
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: editId, trackId: edit.track_id });
    runPointerCommand("stage.edit");
  });

  return {
    stageProps: {
      ...session.props,
      ref: stageRef,
      duration: project?.timeline_duration_sec ?? 0,
      layout: shell === "phone" ? ("phone" as const) : ("desktop" as const),
      bulkRunning: bulkRunning ?? undefined,
      ...comments.stageProps,
      onDecide,
      onHear,
      onOpenInEdit,
      onComment: comments.onComment,
      onResolve: (id: string) =>
        comments.onResolve(id, { ...session.props, selected }),
      onHandOff: () => runPointerCommand("stage.deliver"),
    },
  };
}
