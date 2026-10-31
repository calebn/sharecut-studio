import {
  type ReactNode,
  type Ref,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AuditionSide } from "../system/auditionWindow";
import { DecisionCard } from "../system/DecisionCard";
import { Sheet } from "../system/Sheet";
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
import { stageActionFor } from "./reviewKeys";
import {
  fullOrder,
  groupQueue,
  holdsGateKind,
  type ReviewFilter,
  type ReviewItem,
  type ReviewResult,
  verbOf,
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
  ref?: Ref<HTMLDivElement>;
  items: readonly ReviewItem[];
  content: (item: ReviewItem) => ReviewContent;
  selectedId: string | null;
  filter: ReviewFilter;
  looksRight: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onFilter: (filter: ReviewFilter) => void;
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
  job?: QueueJob;
  bulkRunning?: BulkProgress;
  onOpenInEdit?: (id: string) => void;
  onHear?: (id: string, side: AuditionSide) => void;
  /** Pick the take Accept places for a replace pickup. */
  onSelectTake?: (id: string, takeIndex: number) => void;
  onComment?: (id: string) => void;
  thread?: (item: ReviewItem) => ReactNode;
  /** The inline comment field, above the card. */
  composer?: ReactNode;
  /** Resolving a comment is not a decision: the host owns it and its Undo. */
  onResolve?: (id: string) => void;
  onReply?: (id: string) => void;
  onFindMore?: () => void;
  findMoreDisabled?: string;
  onHandOff?: () => void;
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
  looksRight,
  onSelect,
  onFilter,
  onLooksRight,
  onDecide,
  duration,
  peaks,
  guest = false,
  canDecide = !guest,
  layout = "desktop",
  state = "ready",
  job,
  bulkRunning,
  onOpenInEdit,
  onHear,
  onSelectTake,
  onComment,
  thread,
  composer,
  onResolve,
  onReply,
  onFindMore,
  findMoreDisabled,
  onHandOff,
  onRetry,
}: ReviewStageProps) {
  const [side, setSide] = useState<AuditionSide>("B");
  const [ranges, setRanges] = useState<Record<string, TimeRange>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [waived, setWaived] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
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

  const phone = layout === "phone";
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const gate = !waived && hasCheck;
  const holdsGate = (ids: readonly string[]) =>
    gate &&
    ids.some((id) =>
      items.some(
        (i) => i.id === id && holdsGateKind(i) && verbOf(i) !== "lower",
      ),
    );

  const step = (direction: "forward" | "backward") =>
    onSelect(stepUndecided(items, selectedId, direction, filter));

  const cuttable = (id: string) => {
    const item = items.find((i) => i.id === id);
    return (
      item !== undefined &&
      !item.result &&
      !item.blocked &&
      !(item.unsure && !looksRight.has(id))
    );
  };

  const armed = gate && pending?.ids.some(cuttable) ? pending : null;
  const pendingItem = armed
    ? items.find((i) => i.id === armed.ids[0])
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
    if (item && verbOf(item) === "keep")
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
    bulk(
      groupQueue(items).find((g) => g.items.some((i) => i.id === selectedId))
        ?.bulk?.ids,
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
    const target = openOf(items, "unsure-word")[0] ?? openOf(items, "check")[0];
    onSelect(target?.id ?? selectedId);
  };

  const hear = (next: AuditionSide) => {
    setSide(next);
    if (selected?.kind === "unsure-word") onHear?.(selected.id, "A");
    else if (selected && (wave || card.change)) onHear?.(selected.id, next);
  };

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    const action = stageActionFor(event, {
      primary: selected ? verbOf(selected) : undefined,
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

  const body = selected ? content(selected) : null;
  const base = body?.card.waveform;
  const wave = base && { ...base, ...(selected && ranges[selected.id]) };
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
  const card = body?.card ?? EMPTY_CARD;
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
            if (selected.result) return;
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
          onLooksRight: () => onLooksRight(selected.id),
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
  const position = selected
    ? fullOrder(items).findIndex((i) => i.id === selected.id) + 1
    : 0;

  const queue = (
    <ReviewQueue
      items={items}
      content={content}
      selectedId={selectedId}
      filter={filter}
      job={job}
      bulkRunning={bulkRunning}
      guest={guest}
      canDecide={canDecide}
      state={state}
      onFilter={onFilter}
      onSelect={(id) => {
        onSelect(id);
        setSheetOpen(false);
      }}
      onVerb={verb}
      onKeep={keep}
      onBulk={(group) => {
        bulk(group.bulk?.ids);
        setSheetOpen(false);
      }}
      onFindMore={onFindMore}
      findMoreDisabled={bulkRunning ? BUSY_REASON : findMoreDisabled}
      onRetry={onRetry}
    />
  );

  return (
    <div ref={root} className="rv-stage" data-layout={layout} tabIndex={-1}>
      <div className="rv-main">
        {phone ? (
          <div className="rv-phone-top">
            <Button aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
              <SystemIcon name="inbox" size={14} />
              {!canDecide && items.length === 0
                ? "No comments"
                : `${position} of ${items.length}`}
            </Button>
          </div>
        ) : (
          queue
        )}
        <div className="rv-card">
          {composer}
          <DecisionCard
            key={selected?.id ?? "none"}
            kind={selected?.kind ?? "filler"}
            state={
              state !== "ready" ? state : selected && body ? "ready" : "empty"
            }
            {...card}
            verb={selected ? verbOf(selected) : undefined}
            verbDisabledReason={
              guest && selected?.kind === "comment"
                ? "The host resolves comments."
                : selected?.blocked
                  ? guest
                    ? "The host resolves this one."
                    : "Open it in Edit to resolve."
                  : selected?.kind === "comment" && selected.result
                    ? "Already resolved."
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
                    verb: verbOf(pendingItem),
                    checkLabel: `Check ${unsureWords} ${unsureWords === 1 ? "word" : "words"}`,
                    onConfirm: confirmAnyway,
                    onCheck: checkWords,
                  }
                : held && selected && canDecide
                  ? {
                      verb: verbOf(selected),
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
            emptyAction={
              onHandOff
                ? { label: "Go to Deliver", onClick: onHandOff }
                : undefined
            }
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
        </div>
      </div>
      <div className="rv-foot">
        <ContextStrip
          items={items}
          duration={duration}
          selectedId={selectedId}
          peaks={peaks}
        />
      </div>
      {phone ? (
        <Sheet
          form="bottom"
          title="Review queue"
          open={sheetOpen}
          detent="half"
          onClose={() => setSheetOpen(false)}
        >
          {queue}
        </Sheet>
      ) : null}
    </div>
  );
}
