import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { AuditionSide } from "../system/auditionWindow";
import { DecisionCard } from "../system/DecisionCard";
import { KIND_META } from "../system/decisionKinds";
import { Player } from "../system/Player";
import { Sheet } from "../system/Sheet";
import { SystemIcon } from "../system/SystemIcon";
import type { TimeRange } from "../system/seconds";
import { formatSeconds } from "../system/seconds";
import { iconOf, verbOf } from "../system/verbDisplay";
import { Button, Toast, type ToastState } from "../ui";
import {
  decideAndAdvance,
  nextUndecided,
  previousUndecided,
  undoDecisions,
} from "./advance";
import { ContextStrip } from "./ContextStrip";
import {
  type BulkProgress,
  type ReviewContent,
  ReviewQueue,
} from "./ReviewQueue";
import { reviewActionFor } from "./reviewKeys";
import {
  fullOrder,
  groupQueue,
  type ReviewFilter,
  type ReviewItem,
  type ReviewResult,
  resultText,
} from "./reviewQueue";

export type ReviewStageProps = {
  initialItems: readonly ReviewItem[];
  content: (item: ReviewItem) => ReviewContent;
  /** Episode length in seconds, for the context strip. */
  duration: number;
  peaks?: readonly number[];
  initialSelectedId?: string;
  initialFilter?: ReviewFilter;
  /** A guest reads and comments; nothing here decides. */
  guest?: boolean;
  layout?: "desktop" | "phone";
  state?: "ready" | "loading" | "error";
  job?: { title: string; progress: number };
  bulkRunning?: BulkProgress;
  /** The Q9 default: Cut anyway counts as checking. The prompt shows once per session. */
  gateConfirmed?: boolean;
  /** How long the Undo toast stays. */
  toastMs?: number;
  onOpenInEdit?: (id: string) => void;
  onComment?: (id: string) => void;
  /** Cut anyway was chosen, with the note if one was written. */
  onWaive?: (note?: string) => void;
  onHandOff?: () => void;
  onRetry?: () => void;
};

const CUTS = ["filler", "pause", "sound"];

type Pending = { ids: string[] };

/** The Review stage: queue, Decision card, context strip and Player, with advance, bulk and undo. */
export function ReviewStage({
  initialItems,
  content,
  duration,
  peaks,
  initialSelectedId,
  initialFilter = "all",
  guest = false,
  layout = "desktop",
  state = "ready",
  job,
  bulkRunning,
  gateConfirmed = false,
  toastMs,
  onOpenInEdit,
  onComment,
  onWaive,
  onHandOff,
  onRetry,
}: ReviewStageProps) {
  const [items, setItems] = useState<ReviewItem[]>([...initialItems]);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId ?? nextUndecided(initialItems, null),
  );
  const [filter, setFilter] = useState<ReviewFilter>(initialFilter);
  const [side, setSide] = useState<AuditionSide>("B");
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [ranges, setRanges] = useState<Record<string, TimeRange>>({});
  const [confirmed, setConfirmed] = useState(gateConfirmed);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const phone = layout === "phone";
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const gate = !confirmed && items.some((i) => i.kind === "check" && !i.result);
  const holdsGate = (ids: readonly string[]) =>
    gate &&
    ids.some((id) => CUTS.includes(items.find((i) => i.id === id)?.kind ?? ""));

  const select = (id: string | null) => {
    setSelectedId(id);
    setPending(null);
    setSide("B");
  };

  const apply = (ids: readonly string[], result: ReviewResult) => {
    const closing = ids.some(
      (id) => items.find((i) => i.id === id)?.kind === "unsure-word",
    );
    const after = decideAndAdvance(items, ids, result);
    const unsureLeft = after.items.some(
      (i) => i.kind === "unsure-word" && !i.result,
    );
    const checks =
      closing && !unsureLeft
        ? after.items
            .filter((i) => i.kind === "check" && !i.result)
            .map((i) => i.id)
        : [];
    const all = [...ids, ...checks];
    const out = checks.length ? decideAndAdvance(items, all, result) : after;
    setItems(out.items);
    select(out.selectedId);
    const saved = all.reduce(
      (sum, id) => sum + (items.find((i) => i.id === id)?.savedSeconds ?? 0),
      0,
    );
    const first = items.find((i) => i.id === ids[0]);
    const message =
      result === "kept"
        ? ids.length > 1
          ? `Kept ${ids.length}`
          : "Kept"
        : ids.length > 1
          ? `${verbOf(KIND_META[first?.kind ?? "filler"].verb).label} ${ids.length} · saves ${formatSeconds(saved)}`
          : first
            ? resultText({ ...first, result })
            : "Done";
    setToast({ id: Date.now(), message });
    setUndo(() => () => {
      setItems((current) => undoDecisions(current, all).items);
      select(all[0] ?? null);
      setToast(null);
    });
  };

  const verb = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item || guest) return;
    if (item.unsure && !resolved.has(id)) return;
    if (holdsGate([id])) {
      setPending({ ids: [id] });
      return;
    }
    apply([id], "applied");
  };

  const keep = (id: string) => {
    if (!guest) apply([id], "kept");
  };

  const applyAll = () => {
    const group = groupQueue(items).find((g) =>
      g.items.some((i) => i.id === selectedId),
    );
    if (guest || !group?.bulk) return;
    if (holdsGate(group.bulk.ids)) {
      setPending({ ids: [...group.bulk.ids] });
      return;
    }
    apply(group.bulk.ids, "applied");
  };

  const confirmAnyway = (note?: string) => {
    if (!pending) return;
    setConfirmed(true);
    onWaive?.(note);
    const checks = items
      .filter((i) => i.kind === "check" && !i.result)
      .map((i) => i.id);
    apply([...pending.ids, ...checks], "applied");
  };

  const checkWords = () => {
    const word = items.find((i) => i.kind === "unsure-word" && !i.result);
    const check = items.find((i) => i.kind === "check" && !i.result);
    select((word ?? check)?.id ?? selectedId);
  };

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    const action = reviewActionFor(event, {
      primary: selected ? KIND_META[selected.kind].verb : undefined,
    });
    if (!action) return;
    event.preventDefault();
    if (action === "next") select(nextUndecided(items, selectedId));
    else if (action === "previous")
      select(previousUndecided(items, selectedId));
    else if (action === "hearBefore") setSide("A");
    else if (action === "hearAfter") setSide("B");
    else if (action === "applyAll") applyAll();
    else if (!selected) return;
    else if (action === "verb") verb(selected.id);
    else if (action === "keep") keep(selected.id);
    else if (action === "openInEdit") onOpenInEdit?.(selected.id);
    else if (action === "comment") onComment?.(selected.id);
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
    setRanges({ ...ranges, [selected.id]: next });
    setItems(
      items.map((i) =>
        i.id === selected.id
          ? { ...i, savedSeconds: Math.max(0, i.savedSeconds + delta) }
          : i,
      ),
    );
  };
  const unsure =
    body?.card.unsure && selected
      ? {
          ...body.card.unsure,
          resolved: resolved.has(selected.id),
          onFix: () => {
            setResolved(new Set(resolved).add(selected.id));
            if (selected.kind === "unsure-word")
              apply([selected.id], "applied");
          },
          onLooksRight: () => setResolved(new Set(resolved).add(selected.id)),
        }
      : undefined;
  const unsureWords = items.filter(
    (i) => i.kind === "unsure-word" && !i.result,
  ).length;
  const order = fullOrder(items);
  const position = selected
    ? order.findIndex((i) => i.id === selected.id) + 1
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
      onBulk={(group) => {
        if (!group.bulk) return;
        if (holdsGate(group.bulk.ids)) setPending({ ids: [...group.bulk.ids] });
        else apply(group.bulk.ids, "applied");
      }}
      onRetry={onRetry}
    />
  );

  return (
    <div
      ref={root}
      className="rv-stage"
      data-layout={phone ? "phone" : "card"}
      tabIndex={-1}
    >
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
            {...body?.card}
            title={body?.card.title ?? ""}
            time={body?.card.time ?? ""}
            waveform={wave && { ...wave, onAdjust: adjust }}
            savedSeconds={
              selected && selected.savedSeconds > 0 && wave
                ? selected.savedSeconds
                : undefined
            }
            audition={wave ? { side, onSide: setSide } : undefined}
            unsure={unsure}
            prompt={
              pending && selected
                ? {
                    verb: KIND_META[selected.kind].verb,
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
            onLater={() => select(nextUndecided(items, selectedId))}
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
          icon={<SystemIcon name={iconOf("cut")} size={16} />}
          onUndo={undo ?? undefined}
          onDismiss={() => setToast(null)}
        />
        <Player
          form="bar"
          guest={guest}
          playing={playing}
          time="12:04"
          total="52:10"
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
