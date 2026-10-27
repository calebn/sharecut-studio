import { type RefObject, useLayoutEffect } from "react";
import { KEEP_CLEAR_PX } from "../stage/edit/useCompactInspector";
import type { Selection } from "../types/project";
import {
  capInspectorSheet,
  inspectorSheetBottom,
  inspectorSheetPanel,
  inspectorSheetTop,
} from "../ui/compactSheet";
import { useResizeObserver } from "../ui/useResizeObserver";

function chipFor(
  list: HTMLElement,
  trackId: string,
  wordIndex: number,
): HTMLElement | null {
  for (const chip of list.querySelectorAll<HTMLElement>(
    "[data-transcript-word]",
  )) {
    if (
      chip.dataset.trackId === trackId &&
      Number(chip.dataset.wordIndex) === wordIndex
    ) {
      return chip;
    }
  }
  return null;
}

function selectedSpan(
  selection: Selection,
): { trackId: string; first: number; last: number } | null {
  if (selection?.kind === "transcriptRange") {
    return {
      trackId: selection.trackId,
      first: selection.startWordIndex,
      last: selection.endWordIndex,
    };
  }
  return null;
}

/** Below this the sheet keeps its header and one row of its body. */
const MIN_SHEET_PX = 144;

/** `list` and the ancestors that scroll, nearest first. */
function scrollChain(list: HTMLElement): HTMLElement[] {
  const chain = [list];
  for (
    let node = list.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      node.scrollHeight > node.clientHeight
    )
      chain.push(node);
  }
  return chain;
}

/** The lowest viewport y the sheet or the visual viewport leaves visible. */
function visibleBottom(sheetTop: number): number {
  const viewport = globalThis.visualViewport;
  return viewport
    ? Math.min(sheetTop, viewport.offsetTop + viewport.height)
    : sheetTop;
}

/**
 * Brings the selected words above the inspector sheet that a selection opens,
 * and gives the list room under its last turn as deep as the sheet covers it.
 * The last word wins over the first when the range is taller than the space
 * left. It scrolls the list, then each scrolling ancestor, and when nothing
 * can lift the range clear it shortens the sheet to sit under it. The sheet
 * is measured against the visual viewport, which the keypad can shorten. Each
 * pass lifts that cap first and measures the uncapped sheet, so the cap goes
 * once the space is back.
 */
export function keepSelectionClear(
  list: HTMLElement,
  selection: Selection,
): void {
  capInspectorSheet(null);
  const sheetTop = inspectorSheetTop();
  const span = selectedSpan(selection);
  if (sheetTop === null || !span) {
    list.style.removeProperty("--sheet-clearance");
    return;
  }
  const visible = visibleBottom(sheetTop);
  const box = list.getBoundingClientRect();
  list.style.setProperty(
    "--sheet-clearance",
    `${Math.max(0, Math.round(box.bottom - visible))}px`,
  );
  const last = chipFor(list, span.trackId, span.last);
  if (!last) return;
  const first = chipFor(list, span.trackId, span.first) ?? last;
  const limit = visible - KEEP_CLEAR_PX;
  let overlap = last.getBoundingClientRect().bottom - limit;
  for (const scroller of scrollChain(list)) {
    if (overlap <= 0) break;
    const room = Math.max(
      0,
      first.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    );
    const before = scroller.scrollTop;
    scroller.scrollTop += Math.min(overlap, room);
    overlap -= scroller.scrollTop - before;
  }
  const bottom = inspectorSheetBottom();
  if (overlap > 0 && bottom !== null) {
    const clearTop = visible + overlap;
    capInspectorSheet(Math.max(MIN_SHEET_PX, bottom - clearTop));
  }
}

/** Keeps `selection` clear of the inspector sheet while it is open, and as the sheet or the viewport changes height. */
export function useKeepSelectionClear(
  listRef: RefObject<HTMLElement | null>,
  selection: Selection,
): void {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    keepSelectionClear(list, selection);
    const frame = requestAnimationFrame(() =>
      keepSelectionClear(list, selection),
    );
    const viewport = globalThis.visualViewport;
    const again = () => keepSelectionClear(list, selection);
    viewport?.addEventListener("resize", again);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", again);
      list.style.removeProperty("--sheet-clearance");
      capInspectorSheet(null);
    };
  }, [listRef, selection]);
  useResizeObserver(
    () => (selection ? inspectorSheetPanel() : null),
    () => {
      if (listRef.current) keepSelectionClear(listRef.current, selection);
    },
  );
}
