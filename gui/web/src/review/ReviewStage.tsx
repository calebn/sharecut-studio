import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { AuditionSide } from "../system/auditionWindow";
import { DecisionCard } from "../system/DecisionCard";
import { KIND_META } from "../system/decisionKinds";
import type { SystemIconName } from "../system/icons";
import { Player } from "../system/Player";
import { Sheet } from "../system/Sheet";
import { SystemIcon } from "../system/SystemIcon";
import type { TimeRange } from "../system/seconds";
import { iconOf } from "../system/verbDisplay";
import { Button, Toast, type ToastState } from "../ui";
import { planDecision, stepUndecided, undoDecisions } from "./advance";
import { ContextStrip } from "./ContextStrip";
import {
  type BulkProgress,
  type ReviewContent,
  ReviewQueue,
} from "./ReviewQueue";
import { stageActionFor } from "./reviewKeys";
import {
  fullOrder,
  groupQueue,
  isCut,
  type ReviewFilter,
  type ReviewItem,
  type ReviewResult,
} from "./reviewQueue";

export type ReviewStageProps = {
  initialItems: readonly ReviewItem[];
  content: (item: ReviewItem) => ReviewContent;
  /** Episode length in seconds. */
  duration: number;
  /** Playhead and episode length as the Player shows them. */
  clock: { time: string; total: string };
  peaks?: readonly number[];
  initialSelectedId?: string;
  initialFilter?: ReviewFilter;
  /** A guest reads and comments; nothing here decides. */
  guest?: boolean;
  layout?: "desktop" | "phone";
  state?: "ready" | "loading" | "error";
  job?: { title: string; progress: number };
  bulkRunning?: BulkProgress;
  /** Cut anyway counts as checking. The prompt shows once per session. */
  gateConfirmed?: boolean;
  /** Undo toast lifetime in ms. */
  toastMs?: number;
  onOpenInEdit?: (id: string) => void;
  onComment?: (id: string) => void;
  onWaive?: (note?: string) => void;
  onFindMore?: () => void;
  onHandOff?: () => void;
  onRetry?: () => void;
};

const BLOCKED_WHY = "The server will not apply this yet.";
const EMPTY_CARD: ReviewContent["card"] = { title: "", time: "" };

type Pending = { ids: readonly string[] };

const openOf = (items: readonly ReviewItem[], kind: ReviewItem["kind"]) =>
  items.filter((item) => item.kind === kind && !item.result);

export function ReviewStage({
  initialItems,
  content,
  duration,
  clock,
  peaks,
  initialSelectedId,
  initialFilter = "all",
  guest = false,
  layout = "desktop",
  state = "ready",
  job,
  bulkRunning,
  gateConfirmed = false,
  toastMs = 6000,
  onOpenInEdit,
  onComment,
  onWaive,
  onFindMore,
  onHandOff,
  onRetry,
}: ReviewStageProps) {
  const [items, setItems] = useState<ReviewItem[]>([...initialItems]);
  const [filter, setFilter] = useState<ReviewFilter>(initialFilter);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId ?? stepUndecided(initialItems, null, "forward", filter),
  );
  const [side, setSide] = useState<AuditionSide>("B");
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [ranges, setRanges] = useState<Record<string, TimeRange>>({});
  const [confirmed, setConfirmed] = useState(gateConfirmed);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<
    (ToastState & { icon: SystemIconName }) | null
  >(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);

  const phone = layout === "phone";
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const gate = !confirmed && openOf(items, "check").some((i) => i.transcript);
  const holdsGate = (ids: readonly string[]) =>
    gate &&
    ids.some((id) => {
      const item = items.find((i) => i.id === id);
      return item !== undefined && isCut(item);
    });

  const pendingKind = pending
    ? items.find((i) => i.id === pending.ids[0])?.kind
    : undefined;

  const select = (id: string | null) => {
    setSelectedId(id);
    setPending(null);
    setSide("B");
  };
  const step = (direction: "forward" | "backward") => {
    refocus.current = true;
    select(stepUndecided(items, selectedId, direction, filter));
  };

  const apply = (
    ids: readonly string[],
    result: ReviewResult,
    waive = false,
  ) => {
    const plan = planDecision(items, ids, result, { filter, waive });
    refocus.current = true;
    setItems(plan.items);
    select(plan.selectedId);
    const first = items.find((i) => i.id === ids[0]);
    setToast({
      id: Date.now(),
      message: plan.message,
      icon: iconOf(
        result === "kept" || !first ? "keep" : KIND_META[first.kind].verb,
      ),
    });
    setUndo(() => () => {
      setItems((current) => undoDecisions(current, plan.decidedIds).items);
      setResolved((current) => {
        const next = new Set(current);
        for (const id of plan.decidedIds) next.delete(id);
        return next;
      });
      select(plan.decidedIds[0] ?? null);
      setToast(null);
    });
  };

  const verb = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item || item.result || item.blocked || guest) return;
    if (holdsGate([id])) {
      setPending({ ids: [id] });
      return;
    }
    if (item.unsure && !resolved.has(id)) return;
    apply([id], "applied");
  };

  const keep = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item && !item.result && !guest) apply([id], "kept");
  };

  const bulk = (ids: readonly string[] | undefined) => {
    if (guest || bulkRunning || !ids?.length) return;
    if (holdsGate(ids)) setPending({ ids });
    else apply(ids, "applied");
  };
  const applyGroup = () =>
    bulk(
      groupQueue(items).find((g) => g.items.some((i) => i.id === selectedId))
        ?.bulk?.ids,
    );

  const confirmAnyway = (note?: string) => {
    if (!pending) return;
    setConfirmed(true);
    onWaive?.(note);
    apply(pending.ids, "applied", true);
  };

  const checkWords = () => {
    const target = openOf(items, "unsure-word")[0] ?? openOf(items, "check")[0];
    select(target?.id ?? selectedId);
  };

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    const action = stageActionFor(event, {
      primary: selected ? KIND_META[selected.kind].verb : undefined,
      root: root.current,
    });
    if (!action) return;
    event.preventDefault();
    if (action === "next") step("forward");
    else if (action === "previous") step("backward");
    else if (action === "hearBefore") setSide("A");
    else if (action === "hearAfter") setSide("B");
    else if (action === "applyAll") applyGroup();
    else if (!selected) return;
    else if (action === "verb") verb(selected.id);
    else if (action === "keep") keep(selected.id);
    else if (action === "openInEdit" && !guest) onOpenInEdit?.(selected.id);
    else if (action === "comment") onComment?.(selected.id);
  });
  useLayoutEffect(() => {
    const el = root.current;
    if (refocus.current) {
      refocus.current = false;
      const active = document.activeElement;
      if (el && (!active || active === document.body)) {
        el.focus({ preventScroll: true });
      }
    }
  });

  useLayoutEffect(() => {
    const el = root.current;
    el?.addEventListener("keydown", handleKey);
    return () => el?.removeEventListener("keydown", handleKey);
  }, []);

  const body = selected ? content(selected) : null;
  const range = selected ? ranges[selected.id] : undefined;
  const wave = body?.card.waveform
    ? { ...body.card.waveform, ...range }
    : undefined;
  const adjust = (next: TimeRange) => {
    if (!selected || !wave) return;
    const delta = next.end - next.start - (wave.end - wave.start);
    const id = selected.id;
    setRanges((current) => ({ ...current, [id]: next }));
    setItems((current) =>
      current.map((i) =>
        i.id === id
          ? { ...i, savedSeconds: Math.max(0, i.savedSeconds + delta) }
          : i,
      ),
    );
  };
  const card = body?.card ?? EMPTY_CARD;
  const unsure =
    body?.card.unsure && selected
      ? {
          ...body.card.unsure,
          resolved: resolved.has(selected.id),
          onFix: () => {
            if (guest) return;
            setResolved(new Set(resolved).add(selected.id));
            if (selected.kind === "unsure-word")
              apply([selected.id], "applied");
          },
          onLooksRight: () => {
            if (!guest) setResolved(new Set(resolved).add(selected.id));
          },
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
      state={state}
      onFilter={setFilter}
      onSelect={(id) => {
        select(id);
        setSheetOpen(false);
      }}
      onVerb={verb}
      onKeep={keep}
      onBulk={(group) => bulk(group.bulk?.ids)}
      onFindMore={onFindMore}
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
              {position} of {items.length}
            </Button>
          </div>
        ) : (
          queue
        )}
        <div className="rv-card">
          <DecisionCard
            key={selected?.id ?? "none"}
            kind={selected?.kind ?? "filler"}
            state={
              state !== "ready" ? state : selected && body ? "ready" : "empty"
            }
            {...card}
            why={selected?.blocked ? BLOCKED_WHY : card.why}
            waveform={wave && { ...wave, onAdjust: adjust }}
            savedSeconds={
              selected && selected.savedSeconds > 0 && wave
                ? selected.savedSeconds
                : undefined
            }
            audition={wave ? { side, onSide: setSide } : undefined}
            unsure={unsure}
            prompt={
              pending && pendingKind
                ? {
                    verb: KIND_META[pendingKind].verb,
                    checkLabel: `Check ${unsureWords} ${unsureWords === 1 ? "word" : "words"}`,
                    onConfirm: confirmAnyway,
                    onCheck: checkWords,
                  }
                : undefined
            }
            readOnly={guest}
            layout={phone ? "phone" : "card"}
            emptyAction={
              onHandOff
                ? { label: "Go to Deliver", onClick: onHandOff }
                : undefined
            }
            onRetry={onRetry}
            onVerb={() => selected && verb(selected.id)}
            onKeep={() => selected && keep(selected.id)}
            onLater={() => step("forward")}
            onOpenInEdit={() => selected && onOpenInEdit?.(selected.id)}
            onComment={() => selected && onComment?.(selected.id)}
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
        <Toast
          className="sys-toast-dock"
          toast={toast}
          timeoutMs={toastMs}
          icon={toast ? <SystemIcon name={toast.icon} size={16} /> : undefined}
          onUndo={undo ?? undefined}
          onDismiss={() => setToast(null)}
        />
        <Player
          form="bar"
          guest={guest}
          playing={playing}
          time={clock.time}
          total={clock.total}
          onPlayPause={() => setPlaying(!playing)}
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
