import { type RefObject, useEffect } from "react";
import { KEEP_CLEAR_PX } from "../layout/useCompactInspector";
import type { Selection } from "../types/project";
import { inspectorSheetPanel, inspectorSheetTop } from "../ui/compactSheet";
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
  if (selection?.kind === "transcriptWord") {
    return {
      trackId: selection.trackId,
      first: selection.wordIndex,
      last: selection.wordIndex,
    };
  }
  return null;
}

/**
 * Scrolls the transcript so the selected words sit above the inspector sheet
 * that a selection opens, and gives the list room under its last turn as deep
 * as the sheet covers it. The last word wins over the first when the range is
 * taller than the space left.
 */
export function keepSelectionClear(
  list: HTMLElement,
  selection: Selection,
): void {
  const sheetTop = inspectorSheetTop();
  const span = selectedSpan(selection);
  if (sheetTop === null || !span) {
    list.style.removeProperty("--sheet-clearance");
    return;
  }
  const box = list.getBoundingClientRect();
  list.style.setProperty(
    "--sheet-clearance",
    `${Math.max(0, Math.round(box.bottom - sheetTop))}px`,
  );
  const last = chipFor(list, span.trackId, span.last);
  if (!last) return;
  const first = chipFor(list, span.trackId, span.first) ?? last;
  const overlap =
    last.getBoundingClientRect().bottom - (sheetTop - KEEP_CLEAR_PX);
  if (overlap > 0) {
    list.scrollTop += Math.min(
      overlap,
      Math.max(0, first.getBoundingClientRect().top - box.top),
    );
  }
}

/** Keeps `selection` clear of the inspector sheet while it is open, and as the sheet changes height. */
export function useKeepSelectionClear(
  listRef: RefObject<HTMLElement | null>,
  selection: Selection,
): void {
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    keepSelectionClear(list, selection);
    const frame = requestAnimationFrame(() =>
      keepSelectionClear(list, selection),
    );
    return () => {
      cancelAnimationFrame(frame);
      list.style.removeProperty("--sheet-clearance");
    };
  }, [listRef, selection]);
  useResizeObserver(
    () => (selection ? inspectorSheetPanel() : null),
    () => {
      if (listRef.current) keepSelectionClear(listRef.current, selection);
    },
  );
}
