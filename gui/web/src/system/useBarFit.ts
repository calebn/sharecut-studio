import { type RefObject, useLayoutEffect, useRef } from "react";
import { useResizeObserver } from "../ui/useResizeObserver";

/**
 * How many things the bar can give up, in order (system.css has one rule per
 * level): 1 Status pill text, 2 the Following detail, 3 the skip buttons,
 * 4 the cuts, 5 the hear menu's chevron, 6 the other pills.
 */
export const MAX_FIT_LEVEL = 6;

/** The lowest level at which `fits` is true; the last level when none is. */
export function findFitLevel(
  fits: (level: number) => boolean,
  max: number = MAX_FIT_LEVEL,
): number {
  for (let level = 0; level < max; level += 1) {
    if (fits(level)) return level;
  }
  return max;
}

interface Box {
  left: number;
  right: number;
}

/** The status line's box when it is drawn (not visually hidden), else null. */
function statusPill(column: Element): Element | null {
  const holder = column.querySelector(".sys-player-status");
  if (!holder || getComputedStyle(holder).position === "absolute") return null;
  return holder;
}

/** The span the visible children of a column take, or null when it holds none. */
function extent(column: Element): Box | null {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const child of Array.from(column.children)) {
    // A status squeezed to nothing still has its pill; a hidden one is 1 px.
    const drawn = child.classList.contains("sys-player-status")
      ? statusPill(column)?.firstElementChild
      : child;
    const rect = drawn?.getBoundingClientRect();
    if (!rect || rect.width <= 2) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return left <= right ? { left, right } : null;
}

/**
 * True when what the bar draws at its current level is whole: no column's
 * content leaves the bar or runs into the next column, and the status text is
 * not cut short. Geometry only, so it does not depend on the font.
 */
export function barFits(host: HTMLElement): boolean {
  const bar = host.firstElementChild;
  if (!bar) return true;
  const outer = bar.getBoundingClientRect();
  const boxes = Array.from(bar.children).map(extent);
  let previous = outer.left;
  for (const box of boxes) {
    if (!box) continue;
    if (box.left < previous - 0.5) return false;
    previous = box.right;
  }
  if (previous > outer.right + 0.5) return false;
  const holder = statusPill(bar);
  const pill = holder?.firstElementChild;
  if (holder && pill) {
    const room = holder.getBoundingClientRect();
    const own = pill.getBoundingClientRect();
    if (own.right > room.right + 0.5 || own.left < room.left - 0.5)
      return false;
  }
  const text = holder?.querySelector(".sys-player-pill-text");
  // Visually hidden text (position: absolute, 1 px) is not cut short.
  return (
    !text ||
    getComputedStyle(text).position === "absolute" ||
    text.scrollWidth <= text.clientWidth
  );
}

/** The three columns and everything in them: what the bar's size and its contents' sizes tell. */
const CONTENTS =
  ".sys-player-left, .sys-player-center, .sys-player-right, .sys-player-left > *, .sys-player-center > *, .sys-player-right > *";

/** The sizes of the bar and of what is in its columns, as one string. */
function sizesOf(host: HTMLElement): string {
  return [host, ...Array.from(host.querySelectorAll(CONTENTS))]
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return `${Math.round(rect.width * 2)}x${Math.round(rect.height * 2)}`;
    })
    .join(",");
}

/** Sets `data-fit` on `host` to the lowest level at which the bar fits. */
export function fitBar(host: HTMLElement): void {
  host.dataset.fit = String(
    findFitLevel((level) => {
      host.dataset.fit = String(level);
      return barFits(host);
    }),
  );
}

/** Fits the bar and keeps the sizes it ended with, so a report of those sizes does nothing. */
function refit(host: HTMLElement, settled: { current: string }): void {
  fitBar(host);
  settled.current = sizesOf(host);
}

interface FitProps {
  time: string;
  cuts?: string;
  rate?: number;
  solo?: string;
  state?: string;
  status?: string;
  guest?: boolean;
  following?: { name: string; detail?: string };
  hearMenu?: unknown;
  onComment?: unknown;
}

/**
 * What, besides a size, can change the fit: the strings and flags the bar
 * draws. Not `time` itself (it changes every tick and a digit's width is fixed),
 * only its length (the clock gaining a digit).
 */
export function barFitKey(props: FitProps): string {
  return [
    props.time.length,
    props.cuts,
    props.rate,
    props.solo,
    props.state,
    props.status,
    props.guest ? "guest" : "host",
    props.following?.name,
    props.following?.detail,
    props.hearMenu ? "hear" : "",
    props.onComment ? "comment" : "",
  ].join("|");
}

/**
 * Sets `data-fit` on the bar's host before the first paint and again when
 * something that can change the fit changes: `key` (see `barFitKey`), a size
 * of the bar or of what is in its columns (a ResizeObserver: a pill appearing,
 * a name changing, the clock gaining a digit), an attribute of `<html>` (the
 * text size), the fonts finishing loading, or the pointer type. A re-render
 * that changes none of them measures nothing. A search changes the columns'
 * sizes and so wakes the observer again; the sizes at the end of a search are
 * kept and an observer report that finds the same sizes does nothing, so one
 * change costs one search (at most two with the key). `on` false for the dock
 * and the expanded form: no attribute, no observers.
 */
export function useBarFit(
  ref: RefObject<HTMLElement | null>,
  on: boolean,
  key: string,
) {
  /** The sizes the last search ended with. */
  const settled = useRef("");
  /** The bar and the key the last search was for. */
  const fitted = useRef<{ host: HTMLElement; key: string } | null>(null);
  // No dependency list: the bar's host can change without any input here
  // changing; a render with the same host and key does nothing.
  useLayoutEffect(() => {
    const host = ref.current;
    if (!on || !host) {
      fitted.current = null;
      return;
    }
    if (fitted.current?.host === host && fitted.current.key === key) return;
    fitted.current = { host, key };
    refit(host, settled);
  });
  useResizeObserver(
    [
      ref,
      () =>
        ref.current ? Array.from(ref.current.querySelectorAll(CONTENTS)) : [],
    ],
    () => {
      const host = ref.current;
      if (host && sizesOf(host) !== settled.current) refit(host, settled);
    },
    on,
  );
  useLayoutEffect(() => {
    const host = ref.current;
    if (!on || !host) return;
    const again = () => refit(host, settled);
    // A text-size or theme change sets an attribute on <html>: the widths of the
    // contents change, the bar's does not.
    const root = new MutationObserver(again);
    root.observe(document.documentElement, { attributes: true });
    const fonts = document.fonts;
    void fonts?.ready.then(again);
    fonts?.addEventListener?.("loadingdone", again);
    const pointer = window.matchMedia?.("(pointer: coarse)");
    pointer?.addEventListener?.("change", again);
    return () => {
      root.disconnect();
      fonts?.removeEventListener?.("loadingdone", again);
      pointer?.removeEventListener?.("change", again);
    };
  }, [ref, on]);
}
