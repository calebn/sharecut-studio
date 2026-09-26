/**
 * Virtualize a long list of rows (transcript turns, history groups).
 *
 * Owns the threshold (with hysteresis), stable measurement keys, the rem-based
 * size estimate, flex-gap parity, and a range extractor that keeps the
 * caller's "pinned" rows mounted so follow, scroll requests and focus never
 * target an unmounted row.
 */

import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type Key,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useState,
} from "react";
import { remToPx } from "./useTabsHeight";
import {
  VIRTUALIZE_OFF_ROWS,
  VIRTUALIZE_ON_ROWS,
} from "./virtualRowThresholds";

const OVERSCAN = 8;

export function nextVirtualized(count: number, prev: boolean): boolean {
  if (count >= VIRTUALIZE_ON_ROWS) {
    return true;
  }
  if (count < VIRTUALIZE_OFF_ROWS) {
    return false;
  }
  return prev;
}

/** Visible range plus in-bounds pinned indexes, sorted and unique. */
export function withPinnedIndexes(
  range: Range,
  pinned: readonly number[],
): number[] {
  const indexes = defaultRangeExtractor(range);
  const extra = pinned.filter(
    (i) => i >= 0 && i < range.count && !indexes.includes(i),
  );
  if (extra.length === 0) {
    return indexes;
  }
  return [...new Set([...indexes, ...extra])].sort((a, b) => a - b);
}

/** Props every mounted virtual row slot needs: list-item ARIA, measurement, and position. */
export interface VirtualRowSlotProps {
  role: "listitem";
  "aria-setsize": number;
  "aria-posinset": number;
  "data-index": number;
  ref: (el: Element | null) => void;
  style: CSSProperties;
}

export function virtualRowSlotProps(
  item: VirtualItem,
  count: number,
  measureElement: (el: Element | null) => void,
): VirtualRowSlotProps {
  return {
    role: "listitem",
    "aria-setsize": count,
    "aria-posinset": item.index + 1,
    "data-index": item.index,
    ref: measureElement,
    style: { transform: `translateY(${item.start}px)` },
  };
}

export interface VirtualRows {
  virtualized: boolean;
  /** Mounted virtual rows (empty when not virtualized). */
  items: VirtualItem[];
  totalSize: number;
  /** Spread onto each mounted row slot. */
  slotProps: (item: VirtualItem) => VirtualRowSlotProps;
}

export interface VirtualRowsOptions {
  count: number;
  getItemKey: (index: number) => Key;
  /** Initial per-row height estimate (rem) before measurement. */
  estimateRem: number;
  pinned: readonly number[];
}

export function useVirtualRows(
  listRef: RefObject<HTMLElement | null>,
  { count, getItemKey, estimateRem, pinned }: VirtualRowsOptions,
): VirtualRows {
  const [prevVirtualized, setPrevVirtualized] = useState(
    () => count >= VIRTUALIZE_ON_ROWS,
  );
  const virtualized = nextVirtualized(count, prevVirtualized);
  if (virtualized !== prevVirtualized) {
    setPrevVirtualized(virtualized);
  }
  const [estimatePx] = useState(() => remToPx(estimateRem));
  // Absolutely positioned rows ignore the list's flex `gap`; mirror it.
  const [gap, setGap] = useState(0);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!virtualized || !el) {
      return;
    }
    const rowGap = Number.parseFloat(getComputedStyle(el).rowGap);
    setGap(Number.isFinite(rowGap) ? rowGap : 0);
  }, [listRef, virtualized]);

  const estimateSize = useCallback(() => estimatePx, [estimatePx]);
  const rangeExtractor = useCallback(
    (range: Range) => withPinnedIndexes(range, pinned),
    [pinned],
  );

  const virtualizer = useVirtualizer({
    count: virtualized ? count : 0,
    getScrollElement: () => listRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    gap,
    overscan: OVERSCAN,
  });

  return {
    virtualized,
    items: virtualized ? virtualizer.getVirtualItems() : [],
    totalSize: virtualizer.getTotalSize(),
    slotProps: (item) =>
      virtualRowSlotProps(item, count, virtualizer.measureElement),
  };
}
