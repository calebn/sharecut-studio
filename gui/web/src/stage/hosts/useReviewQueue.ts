import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  acceptSessionSuggestionCommand,
  applySuggestedActions,
  approveEdits,
  correctTranscriptWord,
  loadSessionTakes,
  loadTranscriptCheck,
  markTranscriptChecked,
  rejectEdits,
  replyHistoryHead,
  type SessionTakes,
  selectSessionTakeCommand,
  skipSessionSuggestionCommand,
  waiveTranscriptRefine,
} from "../../api";
import {
  playPendingPreview,
  playSessionPreview,
  releaseSessionPreview,
  warmSessionPreview,
} from "../../audio/pendingPreview";
import {
  executePointerCommand,
  runPointerCommand,
} from "../../commands/pointer";
import { seekTransport } from "../../commands/seek";
import { refreshDocumentProject } from "../../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../../document/cursor";
import { useTranscriptDetail } from "../../document/useTranscriptDetail";
import { REFINE_GATE_GUI_MESSAGE } from "../../inspector/TranscriptRefineRecovery";
import type { BulkProgress } from "../../review/ReviewQueue";
import type { ReviewIntent } from "../../review/ReviewStage";
import {
  CHECK_ID,
  checkEntryOf,
  commentItemId,
  editIdOf,
  hasTakeSwitcher,
  pickupConfirmation,
  type ReviewEntry,
  reviewEntriesOf,
  reviewIdOf,
  sessionEntriesOf,
  sessionIdOf,
  sessionItemId,
  sessionStartSec,
  takeToPlace,
  unsureEntriesOf,
  type WordTarget,
  wordIdOf,
} from "../../review/reviewItems";
import { itemVerb, landPlan } from "../../review/reviewQueueModel";
import { useReviewSession } from "../../review/reviewSession";
import {
  canReviewPendingEdit,
  isGuestSession,
  isShareProjectKey,
} from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { AuditionSide } from "../../system/auditionWindow";
import { selectLowConfidenceStops } from "../../transcript/lowConfidence";
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
import { useReviewAttention } from "./useReviewAttention";
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
const PICKUP_HANDLED = "This suggestion was already handled.";
const PICKUP_UNEXPECTED = "The host sent an unexpected reply. Nothing changed.";
const WORD_LOADING_REASON =
  "The transcript is loading. Wait for the words to load.";
const OPEN_CHECK =
  "The transcript check stays open until every word has loaded.";
const LEFT_AS_IS = "Left as it is. Nobody is talking over it.";
const RELOAD_FAILED =
  "Undone, but the words did not reload. Reload the project to see them.";
const HOST_CHECKS_WORD = "The host checks the unsure word first.";
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

export function useReviewQueue(guestShare = false) {
  const {
    project,
    projectPath,
    projectEpoch,
    shell,
    guestMode,
    shareCapabilities,
    shareAuthor,
    picked,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    shell: s.shellBreakpoint,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    shareAuthor: s.shareAuthor,
    picked: s.selection?.kind === "comment" ? s.selection : null,
  }));
  const guest = isGuestSession(projectPath, guestMode, guestShare);
  const comments = useReviewComments(guest);
  const attention = useReviewAttention(projectPath);
  const [status, setStatus] = useState<TranscriptCheckStatus | null>(null);
  const [bulkRunning, setBulkRunning] = useState<BulkProgress | null>(null);
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const settled = useRef(
    new Map<string, { head: HistoryEntryId; seq: number }>(),
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const requests = useRef(0);
  const confirmed = useRef(new Set<string>());
  const [askedPickups, setAskedPickups] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [takeDetails, setTakeDetails] = useState<
    ReadonlyMap<string, SessionTakes>
  >(new Map());
  const switching = useRef(new Set<string>());
  const canDecide =
    !guest || canReviewPendingEdit(projectPath, shareCapabilities);
  // A guest who cannot decide sees only the suggestions their own link made.
  const pending = useMemo(
    () =>
      canDecide
        ? project?.pending_edits
        : guest && shareAuthor != null
          ? project?.pending_edits?.filter((e) => e.author === shareAuthor)
          : undefined,
    [canDecide, guest, shareAuthor, project?.pending_edits],
  );
  const sessions = guest ? undefined : project?.session_suggestions;
  const tracks = project?.tracks;

  const refreshStatus = useStableCallback(async () => {
    if (guest || isShareProjectKey(projectPath)) return null;
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

  useEffect(() => {
    const listed = new Set((sessions ?? []).map((s) => sessionItemId(s.id)));
    setAskedPickups((prev) => {
      const kept = [...prev].filter(([id]) => listed.has(id));
      return kept.length === prev.size ? prev : new Map(kept);
    });
  }, [sessions]);

  const utterances = guest ? undefined : project?.transcript?.utterances;
  const detail = useTranscriptDetail();
  const activeWordCount =
    detail.kind === "ready" && !guest
      ? selectLowConfidenceStops(utterances ?? []).length
      : null;
  const readyWords = useMemo(
    () =>
      detail.kind === "ready" && !guest
        ? unsureEntriesOf(pending ?? [], utterances ?? [])
        : null,
    [detail.kind, guest, pending, utterances],
  );
  const committedWords = useRef<{
    path: string;
    epoch: number;
    words: ReturnType<typeof unsureEntriesOf>;
  } | null>(null);
  const emptyWords = useMemo(() => unsureEntriesOf([], []), []);
  const words =
    readyWords ??
    (!guest &&
    committedWords.current?.path === projectPath &&
    committedWords.current.epoch === projectEpoch
      ? committedWords.current.words
      : emptyWords);
  useLayoutEffect(() => {
    if (readyWords)
      committedWords.current = {
        path: projectPath,
        epoch: projectEpoch,
        words: readyWords,
      };
    else if (
      guest ||
      committedWords.current?.path !== projectPath ||
      committedWords.current.epoch !== projectEpoch
    )
      committedWords.current = null;
  }, [readyWords, projectPath, projectEpoch, guest]);
  const wordDisabledReason =
    detail.kind === "ready"
      ? undefined
      : detail.kind === "failed"
        ? "The transcript didn't load. Try again."
        : WORD_LOADING_REASON;
  const open = useMemo<ReviewEntry[]>(() => {
    const eligibleWords = guest ? undefined : words.targets;
    const proposals = reviewEntriesOf(
      pending ?? [],
      tracks ?? [],
      eligibleWords,
    );
    const entries = proposals.map(({ item: found, content }) => {
      const item = canDecide ? found : { ...found, mine: true as const };
      if (guest && item.unsure)
        return {
          item: { ...item, blocked: true, hostOnly: true },
          content: {
            ...content,
            card: { ...content.card, why: HOST_CHECKS_WORD },
          },
        };
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
    const check = status && checkEntryOf(status, activeWordCount);
    const pickups = sessionEntriesOf(
      sessions ?? [],
      tracks ?? [],
      takeDetails,
    ).map(({ item, content }) => {
      const message = askedPickups.get(item.id);
      return message
        ? { item, content: { ...content, confirm: { message } } }
        : { item, content };
    });
    return [
      ...entries,
      ...pickups,
      ...words.entries,
      ...(check ? [check] : []),
      ...comments.entries,
    ].map((entry) => {
      if (guest || !entry.content.card.unsure || !wordDisabledReason)
        return entry;
      const unsure = { ...entry.content.card.unsure };
      delete unsure.step;
      return {
        ...entry,
        content: {
          ...entry.content,
          card: {
            ...entry.content.card,
            unsure: { ...unsure, disabledReason: wordDisabledReason },
          },
        },
      };
    });
  }, [
    guest,
    wordDisabledReason,
    canDecide,
    pending,
    held,
    status,
    activeWordCount,
    words,
    comments.entries,
    sessions,
    tracks,
    askedPickups,
    takeDetails,
  ]);
  const pickup = useDawStore((s) => s.pendingReviewItem);
  const session = useReviewSession(open, { selectedId: pickup ?? undefined });
  useEffect(() => {
    if (pickup) {
      useDawStore.getState().setPendingReviewItem(null);
    }
  }, [pickup]);
  const { revert } = session;
  const select = useStableCallback(session.props.onSelect);
  const selected = useStableCallback(() => session.props.selectedId);
  const onFilter = useStableCallback(session.props.onFilter);
  const land = useStableCallback((id: string) => {
    const plan = landPlan(
      open.map((e) => e.item),
      id,
      session.props.filter,
    );
    if (plan.resetFilter) onFilter("all");
    if (plan.select) select(id);
  });
  useEffect(() => {
    if (picked) land(commentItemId(picked.id));
  }, [picked, land]);
  const selectedSession = sessionIdOf(session.props.selectedId ?? "");
  const selectedRow = sessions?.find((s) => s.id === selectedSession);
  const selectedTake = selectedRow ? takeToPlace(selectedRow) : undefined;
  useEffect(() => {
    if (selectedSession && !guest)
      void warmSessionPreview(projectPath, selectedSession, selectedTake);
  }, [selectedSession, selectedTake, guest, projectPath]);
  useEffect(
    () => () => {
      if (selectedSession) releaseSessionPreview(selectedSession);
    },
    [selectedSession],
  );
  const head = project?.history.head_id;
  const detailKey = selectedRow
    ? `${selectedRow.id}|${selectedRow.selected_take}|${selectedRow.take_indexes.join(",")}|${head}`
    : null;
  const wantsDetail = !!selectedRow && hasTakeSwitcher(selectedRow);
  useEffect(() => {
    if (!detailKey || !wantsDetail || !selectedSession || guest) return;
    const controller = new AbortController();
    loadSessionTakes(projectPath, selectedSession, controller.signal)
      .then((reply) => {
        if (controller.signal.aborted) return;
        setTakeDetails((prev) => new Map(prev).set(reply.suggestion_id, reply));
      })
      // The switcher still works without the detail; Accept names any refusal.
      .catch(() => undefined);
    return () => controller.abort();
  }, [detailKey, wantsDetail, selectedSession, guest, projectPath]);
  // Whatever changes the chosen take (our pick, Undo, another client), what was playing is the old one.
  const chosenTakes = useRef(new Map<string, number | undefined>());
  useEffect(() => {
    const next = new Map((sessions ?? []).map((s) => [s.id, takeToPlace(s)]));
    for (const [id, take] of next)
      if (chosenTakes.current.has(id) && chosenTakes.current.get(id) !== take)
        releaseSessionPreview(id);
    chosenTakes.current = next;
  }, [sessions]);
  useEffect(() => {
    const listed = new Set((sessions ?? []).map((s) => s.id));
    setTakeDetails((prev) => {
      const kept = [...prev].filter(([id]) => listed.has(id));
      return kept.length === prev.size ? prev : new Map(kept);
    });
  }, [sessions]);
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
    if (ids.length === 1 && item && itemVerb(item) === "lower") {
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

  /** Accept or Skip one staged record session; a held replace asks before it goes ahead. */
  const decideSession = async (
    intent: ReviewIntent,
    plan: NonNullable<ReturnType<typeof session.decide>>,
    suggestionId: string,
  ) => {
    const { projectPath: path, projectEpoch: epoch } = useDawStore.getState();
    const { announceStatus: say } = useDawStore.getState();
    const current = () => {
      const s = useDawStore.getState();
      return s.projectPath === path && s.projectEpoch === epoch;
    };
    const itemId = sessionItemId(suggestionId);
    const row = useDawStore
      .getState()
      .project?.session_suggestions?.find((s) => s.id === suggestionId);
    if (!row && intent.result !== "kept") {
      // Another client handled it: the take the user saw is unknown, so send nothing.
      session.revert(plan.decidedIds, plan.selectedId);
      say(PICKUP_HANDLED, { tone: "error" });
      void refreshDocumentProject(path).catch(() => null);
      return false;
    }
    try {
      const takeIndex = row ? takeToPlace(row) : undefined;
      const reply =
        intent.result === "kept"
          ? await skipSessionSuggestionCommand(path, suggestionId)
          : await acceptSessionSuggestionCommand(path, suggestionId, {
              ...(takeIndex === undefined ? {} : { takeIndex }),
              overrideAudioChecks: intent.override === true,
            });
      if (!current()) return;
      const ask = pickupConfirmation(
        reply,
        useDawStore.getState().project?.tracks ?? [],
      );
      if (reply.needs_confirmation != null) {
        session.revert(plan.decidedIds, plan.selectedId);
        if (!ask) {
          say(PICKUP_UNEXPECTED, { tone: "error" });
          return false;
        }
        setAskedPickups((prev) => new Map(prev).set(itemId, ask));
        return false;
      }
      setAskedPickups((prev) => {
        if (!prev.has(itemId)) return prev;
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
      if (reply.queued === true) return say(PENDING_REVIEW_QUEUED_MESSAGE);
      const historyHead = replyHistoryHead(reply);
      if (historyHead)
        settled.current.set(itemId, {
          head: historyHead,
          seq: currentDocumentSeq(),
        });
      say(plan.message, {
        undo: historyHead,
        onUndone: () => {
          session.revert(plan.decidedIds);
          stageRef.current?.focus({ preventScroll: true });
        },
        returnFocus: () => stageRef.current,
      });
      return true;
    } catch (error) {
      session.revert(plan.decidedIds, plan.selectedId);
      if (!current()) return false;
      const gate =
        error instanceof ApiError &&
        error.code === TRANSCRIPT_REFINE_REQUIRED_CODE;
      if (gate) void refreshStatus();
      say(gate ? REFINE_GATE_GUI_MESSAGE : errorMessage(error), {
        tone: "error",
      });
      return false;
    }
  };

  const currentWord = (id: string): WordTarget | undefined => {
    const live = useDawStore.getState();
    return live.projectPath === projectPath &&
      live.projectEpoch === projectEpoch &&
      live.project === project &&
      detail.kind === "ready" &&
      live.project?.meta.hydration?.transcript_words !== false
      ? words.targets.get(id)
      : undefined;
  };

  const onDecide = useStableCallback(async (intent: ReviewIntent) => {
    const live = useDawStore.getState();
    if (live.projectPath !== projectPath || live.projectEpoch !== projectEpoch)
      return false;
    if (intent.ids.some((id) => id.startsWith("word:") && !currentWord(id)))
      return false;
    const plan = session.decide(intent);
    if (!plan) return;
    const suggestionId = sessionIdOf(intent.ids[0] ?? "");
    if (suggestionId) return decideSession(intent, plan, suggestionId);
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
      if (next && checkEntryOf(next, null) && !changedText && !intent.waive)
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
    if (id.startsWith("word:")) {
      const word = currentWord(id);
      if (!word) {
        useDawStore
          .getState()
          .announceStatus(wordDisabledReason ?? WORD_LOADING_REASON);
        return;
      }
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
    const suggestionId = sessionIdOf(id);
    if (suggestionId) {
      const row = sessions?.find((s) => s.id === suggestionId);
      const takeIndex = row ? takeToPlace(row) : undefined;
      const outcome = await playSessionPreview(
        projectPath,
        suggestionId,
        side === "A" ? "current" : "suggested",
        {
          padSec: HEAR_PAD_SEC + 1,
          ...(takeIndex === undefined ? {} : { takeIndex }),
        },
      );
      if (outcome.status === "disabled")
        useDawStore
          .getState()
          .announceStatus(outcome.reason, { tone: "error" });
      return;
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

  /** Pick the take Accept places; choosing the one already chosen sends nothing. */
  const onSelectTake = useStableCallback(
    async (id: string, takeIndex: number) => {
      const suggestionId = sessionIdOf(id);
      const row = sessions?.find((s) => s.id === suggestionId);
      if (!suggestionId || !row || guest || !hasTakeSwitcher(row)) return;
      if (takeToPlace(row) === takeIndex) return;
      if (switching.current.has(suggestionId)) return;
      switching.current.add(suggestionId);
      const { projectPath: path, projectEpoch: epoch } = useDawStore.getState();
      try {
        await selectSessionTakeCommand(path, suggestionId, takeIndex);
      } catch (error) {
        const s = useDawStore.getState();
        if (s.projectPath === path && s.projectEpoch === epoch)
          s.announceStatus(errorMessage(error), { tone: "error" });
        return false;
      } finally {
        switching.current.delete(suggestionId);
      }
    },
  );

  const onOpenInEdit = useStableCallback(async (id: string) => {
    if (id.startsWith("word:")) {
      const word = currentWord(id);
      if (!word) {
        useDawStore
          .getState()
          .announceStatus(wordDisabledReason ?? WORD_LOADING_REASON);
        return;
      }
      const state = useDawStore.getState();
      state.setSelection({
        kind: "transcriptRange",
        trackId: word.trackId,
        sourceId: word.sourceId,
        startWordIndex: word.wordIndex,
        endWordIndex: word.wordIndex,
      });
      if (word.at !== null) await seekTransport(word.at);
      const request = state.requestEditWordReveal({
        trackId: word.trackId,
        sourceId: word.sourceId,
        wordIndex: word.wordIndex,
      });
      return executePointerCommand("stage.edit", { surface: "text" }).then(
        (result) => {
          if (result.status !== "ok")
            useDawStore.getState().consumeEditWordReveal(request);
          return result;
        },
        (error: unknown) => {
          useDawStore.getState().consumeEditWordReveal(request);
          throw error;
        },
      );
    }
    const suggestionId = sessionIdOf(id);
    if (suggestionId) {
      const row = sessions?.find((s) => s.id === suggestionId);
      const at = row ? sessionStartSec(row) : null;
      if (at !== null) await seekTransport(at);
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
      wordDetail: guest ? undefined : detail,
      documentKey: JSON.stringify([projectPath, projectEpoch]),
      guest,
      canDecide,
      attention,
      ...comments.stageProps,
      onDecide,
      onHear,
      onSelectTake,
      onOpenInEdit,
      onComment: comments.onComment,
      onResolve: (id: string) =>
        comments.onResolve(id, {
          ...session.props,
          selected,
          root: () => stageRef.current,
        }),
    },
  };
}
