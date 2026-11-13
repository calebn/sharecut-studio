import {
  Fragment,
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TranscriptDetailView } from "../document/useTranscriptDetail";
import { useShortLayoutViewport } from "../hooks/useShortLayoutViewport";
import type { AuditionSide } from "../system/auditionWindow";
import { DecisionCard } from "../system/DecisionCard";
import { Sheet } from "../system/Sheet";
import { Skeleton } from "../system/Skeleton";
import { StatusRow } from "../system/StatusRow";
import { SystemIcon } from "../system/SystemIcon";
import type { TimeRange } from "../system/seconds";
import { Button } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { stepUndecided } from "./advance";
import { ContextStrip } from "./ContextStrip";
import {
  type BulkProgress,
  type QueueJob,
  type ReviewContent,
  ReviewQueue,
} from "./ReviewQueue";
import { reviewCompletenessOf } from "./reviewCompleteness";
import { stageActionFor } from "./reviewKeys";
import {
  attentionVisible,
  filterItems,
  fullOrder,
  groupQueue,
  holdsGateKind,
  itemVerb,
  OPEN_REVIEW_ATTENTION_EVENT,
  type ReviewAttention,
  type ReviewFilter,
  type ReviewItem,
  type ReviewResult,
  type ReviewSort,
} from "./reviewQueueModel";

export type ReviewIntent = {
  ids: readonly string[];
  result: ReviewResult;
  waive?: { note?: string };
  /** The corrected text of an unsure word; same as its own text means Looks right. */
  text?: string;
  /** Sent by a group verb, which never cuts through unsure words. */
  group?: true;
  /** Replace anyway: a held pickup goes ahead over the speech it removes. */
  override?: true;
};

export type ReviewStageProps = {
  wordDetail?: TranscriptDetailView;
  documentKey?: string;
  ref?: Ref<HTMLDivElement>;
  items: readonly ReviewItem[];
  content: (item: ReviewItem) => ReviewContent;
  selectedId: string | null;
  filter: ReviewFilter;
  /** The person whose edits show; absent or null for everyone. */
  speaker?: string | null;
  /** By kind (default) or by where each edit sits in the episode. */
  sort?: ReviewSort;
  looksRight: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onFilter: (filter: ReviewFilter) => void;
  onSpeaker?: (speaker: string | null) => void;
  onSort?: (sort: ReviewSort) => void;
  onLooksRight: (id: string) => void;
  /** A promise that resolves to false says the decision failed. */
  onDecide: (intent: ReviewIntent) => void | Promise<boolean | void>;
  /** Episode length in seconds. */
  duration: number;
  peaks?: readonly number[];
  /** A guest reads and comments; the host owns Resolve, Find more and Deliver. */
  guest?: boolean;
  /** Who may Cut or Keep: the host and Editor guests. Defaults to everyone but a guest. */
  canDecide?: boolean;
  layout?: "desktop" | "phone";
  state?: "ready" | "loading" | "error";
  attention?: ReviewAttention;
  job?: QueueJob;
  bulkRunning?: BulkProgress;
  onOpenInEdit?: (id: string) => void;
  onHear?: (id: string, side: AuditionSide) => void;
  /** Pick the take Accept places for a replace pickup. */
  onSelectTake?: (
    id: string,
    takeIndex: number,
  ) => void | Promise<boolean | void>;
  onComment?: (id: string) => void;
  onPlayComment?: (id: string) => void;
  thread?: (item: ReviewItem) => ReactNode;
  /** The inline comment field, above the card. */
  composer?: ReactNode;
  /** The comment this person just posted, for the phone Listen row to say so. */
  posted?: { text: string } | null;
  /** Guest Review: the Player card, first in the center column. */
  centerTop?: ReactNode;
  /** Guest Review: the transcript, after the composer. */
  centerBottom?: ReactNode;
  /** The region that failed to load, in place of the transcript (else the queue). */
  regionFailure?: ReactNode;
  /** Resolving a comment is not a decision: the host owns it and its Undo. */
  onResolve?: (id: string) => void;
  onReply?: (id: string) => void;
  onFindMore?: () => void;
  findMoreDisabled?: string;
  onRetry?: () => void;
};

const BLOCKED_WHY = "The server will not apply this yet.";
const EMPTY_CARD: ReviewContent["card"] = { title: "", time: "" };

type Pending = { ids: readonly string[]; group?: true };

const openOf = (items: readonly ReviewItem[], kind: ReviewItem["kind"]) =>
  items.filter((item) => item.kind === kind && !item.result);

export function ReviewStage({
  ref,
  items,
  content,
  selectedId,
  filter,
  speaker = null,
  sort = "kind",
  looksRight,
  onSelect,
  onFilter,
  onSpeaker,
  onSort,
  onLooksRight,
  onDecide,
  duration,
  peaks,
  guest = false,
  attention,
  canDecide = !guest,
  layout = "desktop",
  state = "ready",
  job,
  bulkRunning,
  onOpenInEdit,
  onHear,
  onSelectTake,
  onComment,
  onPlayComment,
  thread,
  composer,
  centerTop,
  centerBottom,
  regionFailure,
  wordDetail,
  documentKey,
  onResolve,
  onReply,
  onFindMore,
  findMoreDisabled,
  onRetry,
}: ReviewStageProps) {
  const [side, setSide] = useState<AuditionSide>("B");
  const [ranges, setRanges] = useState<Record<string, TimeRange>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [waived, setWaived] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const phone = layout === "phone";
  useEffect(() => {
    if (!phone) return;
    const open = () => setSheetOpen(true);
    window.addEventListener(OPEN_REVIEW_ATTENTION_EVENT, open);
    return () => window.removeEventListener(OPEN_REVIEW_ATTENTION_EVENT, open);
  }, [phone]);
  const [seen, setSeen] = useState(selectedId);
  const hasCheck = openOf(items, "check").some((i) => i.transcript);
  const [hadCheck, setHadCheck] = useState(hasCheck);
  const root = useRef<HTMLDivElement>(null);
  const engaged = useRef(false);
  useImperativeHandle(ref, () => root.current as HTMLDivElement, []);

  if (seen !== selectedId) {
    setSeen(selectedId);
    setSide("B");
    setPending(null);
  }

  if (hadCheck !== hasCheck) {
    setHadCheck(hasCheck);
    if (hasCheck) setWaived(false);
    else setPending(null);
  }

  const short = useShortLayoutViewport();
  const dockedComposer = phone && guest && !short;
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const completeness = reviewCompletenessOf(items, wordDetail?.kind, speaker);
  const gate = !waived && hasCheck;
  const holdsGate = (ids: readonly string[]) =>
    gate &&
    ids.some((id) =>
      items.some(
        (i) => i.id === id && holdsGateKind(i) && itemVerb(i) !== "lower",
      ),
    );

  const step = (direction: "forward" | "backward") =>
    onSelect(
      stepUndecided(items, selectedId, direction, filter, speaker, sort),
    );

  /** Why Accept would refuse the take a pickup has chosen, if it would. */
  const takeRefusal = (item: ReviewItem) => {
    const chosen = content(item).takes;
    const refusal = chosen?.takes.find(
      (t) => t.takeIndex === chosen.selected,
    )?.refusal;
    return refusal ? `This take cannot be placed: ${refusal}` : undefined;
  };
  const cuttable = (id: string) => {
    const item = items.find((i) => i.id === id);
    return (
      item !== undefined &&
      !item.result &&
      !item.blocked &&
      !(
        item.kind === "unsure-word" && content(item).card.unsure?.disabledReason
      ) &&
      !(item.kind === "pickup" && takeRefusal(item)) &&
      !(item.unsure && !looksRight.has(id))
    );
  };

  const pendingItem =
    pending && items.find((i) => !i.result && pending.ids.includes(i.id));
  if (pending && !pendingItem) setPending(null);
  const armed = gate && pendingItem ? pending : null;
  const confirmDisabledReason = bulkRunning
    ? BUSY_REASON
    : armed && !armed.ids.some(cuttable)
      ? "None of these suggestions can be applied right now."
      : undefined;

  const keep = (id: string) => {
    if (
      canDecide &&
      items.some(
        (i) =>
          i.id === id &&
          !i.result &&
          !i.transcript &&
          i.kind !== "unsure-word" &&
          i.kind !== "comment",
      )
    )
      void onDecide({ ids: [id], result: "kept" });
  };

  const verb = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item?.kind === "comment")
      return item.result || guest ? undefined : onResolve?.(id);
    if (!canDecide) return;
    if (item && itemVerb(item) === "keep")
      return item.blocked ? undefined : keep(id);
    if (!cuttable(id)) return;
    if (holdsGate([id])) setPending({ ids: [id] });
    else void onDecide({ ids: [id], result: "applied" });
  };

  const bulk = (all: readonly string[] | undefined) => {
    const ids = all?.filter(cuttable) ?? [];
    if (!canDecide || bulkRunning || !ids.length) return;
    if (holdsGate(ids)) setPending({ ids, group: true });
    else void onDecide({ ids, result: "applied", group: true });
  };
  const applyGroup = () =>
    sort === "kind" &&
    bulk(
      groupQueue(filterItems(items, "all", speaker)).find((g) =>
        g.items.some((i) => i.id === selectedId),
      )?.bulk?.ids,
    );

  const confirmAnyway = (note?: string) => {
    const ids = armed?.ids.filter(cuttable) ?? [];
    if (!canDecide || bulkRunning || !ids.length) return;
    const done = onDecide({
      ids,
      result: "applied",
      waive: { note },
      ...(armed?.group && { group: true as const }),
    });
    setWaived(true);
    void Promise.resolve(done)
      .catch(() => false)
      .then((ok) => ok === false && setWaived(false));
    setPending(null);
  };

  const checkWords = () => {
    const visible = filterItems(items, "all", speaker);
    const target =
      openOf(visible, "unsure-word")[0] ?? openOf(visible, "check")[0];
    onSelect(target?.id ?? selectedId);
  };

  const body = selected ? content(selected) : null;
  const base = body?.card.waveform;
  const wave = base && { ...base, ...(selected && ranges[selected.id]) };
  const card = body?.card ?? EMPTY_CARD;

  const hear = (next: AuditionSide) => {
    setSide(next);
    if (selected?.kind === "unsure-word") onHear?.(selected.id, "A");
    else if (selected && (wave || card.change)) onHear?.(selected.id, next);
  };

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    const action = stageActionFor(event, {
      primary: selected ? itemVerb(selected) : undefined,
      root: root.current,
    });
    if (!action) return;
    event.preventDefault();
    if (action === "next") step("forward");
    else if (action === "previous") step("backward");
    else if (action === "hearBefore") hear("A");
    else if (action === "hearAfter") hear("B");
    else if (action === "applyAll") applyGroup();
    else if (!selected) return;
    else if (action === "verb") verb(selected.id);
    else if (action === "keep") keep(selected.id);
    else if (action === "openInEdit" && !guest) onOpenInEdit?.(selected.id);
    else if (action === "comment") {
      // The window keymap also binds C to comment.draftAt; one of them opens it.
      if (onComment) event.stopPropagation();
      onComment?.(selected.id);
    } else if (action === "reply") onReply?.(selected.id);
  });
  useLayoutEffect(() => {
    const el = root.current;
    const active = document.activeElement;
    if (engaged.current && el && (!active || active === document.body)) {
      el.focus({ preventScroll: true });
    }
  });

  useLayoutEffect(() => {
    const el = root.current;
    const enter = () => {
      engaged.current = true;
    };
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget && !el?.contains(event.relatedTarget as Node)) {
        engaged.current = false;
      }
    };
    const outside = (event: PointerEvent) => {
      if (!el?.contains(event.target as Node)) engaged.current = false;
    };
    el?.addEventListener("focusin", enter);
    el?.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", outside);
    return () => {
      el?.removeEventListener("focusin", enter);
      el?.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", outside);
    };
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    el?.addEventListener("keydown", handleKey);
    return () => el?.removeEventListener("keydown", handleKey);
  }, []);

  const adjust = (next: TimeRange) => {
    if (selected) setRanges((current) => ({ ...current, [selected.id]: next }));
  };
  const savedSeconds =
    selected && base && wave
      ? Math.max(
          0,
          selected.savedSeconds +
            (wave.end - wave.start) -
            (base.end - base.start),
        )
      : 0;
  const context =
    completeness.wordsKnown && !card.unsure?.disabledReason
      ? card.unsure?.context
      : undefined;
  const excerpt = context ? (
    <>
      {context.before.length ? `${context.before.join(" ")} ` : null}
      <strong className="sys-sugg-unsure">{context.focus}</strong>
      {context.after.length ? ` ${context.after.join(" ")}` : null}
    </>
  ) : (
    card.excerpt
  );
  const held = selected && !selected.result ? body?.confirm : undefined;
  const unsure =
    body?.card.unsure && selected && !guest
      ? {
          ...body.card.unsure,
          resolved: looksRight.has(selected.id),
          ...(selected.kind === "unsure-word" && onHear
            ? { onHear: () => onHear(selected.id, "A") }
            : {}),
          onFix: (text: string) => {
            if (selected.result || body.card.unsure?.disabledReason) return;
            if (selected.kind === "unsure-word")
              return void onDecide({
                ids: [selected.id],
                result: "applied",
                text,
              });
            const word = body.card.unsure?.id;
            if (word) void onDecide({ ids: [word], result: "applied", text });
            onSelect(selected.id);
          },
          onLooksRight: () => {
            if (!body.card.unsure?.disabledReason) onLooksRight(selected.id);
          },
        }
      : undefined;
  const takes =
    body?.takes && selected && !selected.result && canDecide && !guest
      ? {
          ...body.takes,
          onSelect: (takeIndex: number) =>
            onSelectTake?.(selected.id, takeIndex),
        }
      : undefined;
  const unsureWords = openOf(items, "unsure-word").length;
  const checkLabel = completeness.wordsKnown
    ? `Check ${unsureWords} ${unsureWords === 1 ? "word" : "words"}`
    : "Check words";
  const position = selected
    ? fullOrder(items, sort).findIndex((i) => i.id === selected.id) + 1
    : 0;

  const guestColumn = centerTop !== undefined || centerBottom !== undefined;
  const queue =
    regionFailure && !guestColumn ? (
      regionFailure
    ) : (
      <ReviewQueue
        items={items}
        content={content}
        selectedId={selectedId}
        filter={filter}
        speaker={speaker}
        sort={sort}
        job={job}
        bulkRunning={bulkRunning}
        guest={guest}
        canDecide={canDecide}
        detailKind={wordDetail?.kind}
        attention={attention}
        state={state}
        onFilter={onFilter}
        onSort={onSort}
        onSpeaker={
          onSpeaker &&
          ((next) => {
            setPending(null);
            onSpeaker(next);
            const open = items.find((i) => i.id === selectedId);
            if (next !== null && open?.speaker && open.speaker.id !== next)
              onSelect(
                stepUndecided(items, null, "forward", filter, next, sort),
              );
          })
        }
        onSelect={(id) => {
          onSelect(id);
          setSheetOpen(false);
        }}
        onPlayComment={onPlayComment}
        onVerb={verb}
        onKeep={keep}
        onBulk={(group) => {
          bulk(group.bulk?.ids);
          setSheetOpen(false);
        }}
        onBulkIds={(ids) => {
          bulk(ids);
          setSheetOpen(false);
        }}
        onFindMore={onFindMore}
        findMoreDisabled={bulkRunning ? BUSY_REASON : findMoreDisabled}
        onRetry={onRetry}
      />
    );

  return (
    <div
      ref={root}
      className="rv-stage"
      data-layout={layout}
      data-guest-column={guestColumn || undefined}
      tabIndex={-1}
    >
      <div className="rv-main">
        {phone && regionFailure && !guestColumn ? (
          regionFailure
        ) : phone ? (
          <div className="rv-phone-top">
            <Button aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
              <SystemIcon name="inbox" size={14} />
              {completeness.total === null
                ? "Review queue"
                : `${position} of ${completeness.total}`}
              {attentionVisible(attention, "all") ? " · Needs attention" : ""}
            </Button>
            <button
              type="button"
              className="sys-icon-btn"
              aria-haspopup="dialog"
              aria-label="Filter the queue"
              title="Filter the queue"
              onClick={() => setSheetOpen(true)}
            >
              <SystemIcon name="sliders-horizontal" size={16} />
            </button>
          </div>
        ) : (
          queue
        )}
        <div className="rv-card">
          {centerTop}
          {wordDetail?.kind === "pending" ? (
            <Skeleton rows={1} onRetry={wordDetail.retry} />
          ) : wordDetail?.kind === "failed" ? (
            <StatusRow
              state="failed"
              title="The transcript didn't load"
              detail="Try again in a moment."
              action={{
                label: "Try again",
                onAction: wordDetail.retry,
                disabledReason: wordDetail.recovering ? BUSY_REASON : undefined,
              }}
            />
          ) : null}

          {!dockedComposer && <Fragment key="composer">{composer}</Fragment>}
          {regionFailure && guestColumn ? regionFailure : centerBottom}
          {guestColumn && !selected ? null : !selected &&
            !completeness.wordsKnown ? null : (
            <DecisionCard
              key={JSON.stringify([documentKey, selected?.id ?? "none"])}
              kind={selected?.kind ?? "filler"}
              state={
                state !== "ready" ? state : selected && body ? "ready" : "empty"
              }
              {...card}
              excerpt={excerpt}
              verb={selected ? itemVerb(selected) : undefined}
              verbDisabledReason={
                selected?.kind === "unsure-word" && card.unsure?.disabledReason
                  ? card.unsure.disabledReason
                  : guest && selected?.kind === "comment"
                    ? "The host resolves comments."
                    : selected?.blocked
                      ? guest
                        ? "The host resolves this one."
                        : "Open it in Edit to resolve."
                      : selected?.kind === "comment" && selected.result
                        ? "Already resolved."
                        : selected?.kind === "pickup" && !selected.result
                          ? takeRefusal(selected)
                          : undefined
              }
              thread={selected && thread?.(selected)}
              why={selected?.blocked ? (card.why ?? BLOCKED_WHY) : card.why}
              waveform={wave && { ...wave, onAdjust: adjust }}
              savedSeconds={savedSeconds > 0 ? savedSeconds : undefined}
              audition={
                wave || card.change
                  ? { side, onSide: setSide, onHear: hear }
                  : undefined
              }
              unsure={unsure}
              takes={onSelectTake ? takes : undefined}
              prompt={
                armed && pendingItem
                  ? {
                      verb: itemVerb(pendingItem),
                      checkLabel,
                      confirmDisabledReason,
                      onConfirm: confirmAnyway,
                      onCheck: checkWords,
                    }
                  : held && selected && canDecide
                    ? {
                        verb: itemVerb(selected),
                        message: held.message,
                        allowNote: false,
                        onConfirm: () =>
                          void onDecide({
                            ids: [selected.id],
                            result: "applied",
                            override: true,
                          }),
                      }
                    : undefined
              }
              readOnly={!canDecide}
              canEdit={!guest}
              layout={phone ? "phone" : "card"}
              onRetry={onRetry}
              onVerb={() => selected && verb(selected.id)}
              onKeep={
                selected?.transcript ||
                selected?.kind === "unsure-word" ||
                selected?.kind === "comment"
                  ? undefined
                  : () => selected && keep(selected.id)
              }
              onLater={() => step("forward")}
              onOpenInEdit={() => selected && onOpenInEdit?.(selected.id)}
              onComment={
                onComment ? () => selected && onComment(selected.id) : undefined
              }
            />
          )}
          {dockedComposer && <Fragment key="composer">{composer}</Fragment>}
        </div>
      </div>
      {centerTop ? null : (
        <div className="rv-foot">
          <ContextStrip
            items={items}
            duration={duration}
            selectedId={selectedId}
            peaks={peaks}
          />
        </div>
      )}
      {phone ? (
        <Sheet
          form="bottom"
          title="Review queue"
          open={sheetOpen}
          detent="full"
          onClose={() => setSheetOpen(false)}
        >
          {queue}
        </Sheet>
      ) : null}
    </div>
  );
}
