import { type PointerEvent, useEffect, useRef } from "react";

const SHIFT = "--sys-source-shift";

type Gesture = {
  id: string;
  pointerId: number;
  startY: number;
  from: number;
  to: number;
  cards: HTMLElement[];
  tops: number[];
  heights: number[];
  stride: number;
  release: () => void;
};

export type SourceGrip = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
};

function clearShifts(cards: readonly HTMLElement[]): void {
  for (const card of cards) {
    card.style.removeProperty(SHIFT);
    card.removeAttribute("data-reordering");
    card.removeAttribute("data-making-room");
  }
}

/**
 * Pointer drag to reorder the Source cards of one session. The grip returned
 * for a card moves that card with the pointer, the cards it passes make room,
 * and letting go reports the card's new place among its siblings. Escape or a
 * cancelled pointer puts everything back. The card menu stays the keyboard path.
 */
export function useSourceReorder(
  onReorder: (id: string, toIndex: number) => void,
): (id: string) => SourceGrip {
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef(onReorder);
  useEffect(() => {
    latest.current = onReorder;
  });

  const end = (commit: boolean) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    current.release();
    clearShifts(current.cards);
    if (commit && current.to !== current.from)
      latest.current(current.id, current.to);
  };

  useEffect(
    () => () => {
      end(false);
    },
    [],
  );

  return (id) => ({
    onPointerDown: (event) => {
      if (
        gesture.current ||
        (event.pointerType === "mouse" && event.button !== 0)
      )
        return;
      const card = event.currentTarget.closest<HTMLElement>("[data-source-id]");
      const list = card?.parentElement?.parentElement;
      const cards = list
        ? [
            ...list.querySelectorAll<HTMLElement>(
              ":scope > * > [data-source-id]",
            ),
          ]
        : [];
      const from = card ? cards.indexOf(card) : -1;
      if (from < 0 || cards.length < 2) return;
      event.preventDefault();
      const grip = event.currentTarget;
      grip.setPointerCapture?.(event.pointerId);
      const rects = cards.map((one) => one.getBoundingClientRect());
      const gap = rects[1]!.top - rects[0]!.bottom;
      const onKey = (key: KeyboardEvent) => {
        if (key.key === "Escape") end(false);
      };
      window.addEventListener("keydown", onKey);
      gesture.current = {
        id,
        pointerId: event.pointerId,
        startY: event.clientY,
        from,
        to: from,
        cards,
        tops: rects.map((rect) => rect.top),
        heights: rects.map((rect) => rect.height),
        stride: rects[from]!.height + Math.max(0, gap),
        release: () => {
          window.removeEventListener("keydown", onKey);
          if (grip.hasPointerCapture?.(event.pointerId))
            grip.releasePointerCapture(event.pointerId);
        },
      };
      card?.setAttribute("data-reordering", "true");
    },
    onPointerMove: (event) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const { cards, tops, heights, from, stride } = current;
      const first = tops[0]!;
      const last = tops[cards.length - 1]! + heights[cards.length - 1]!;
      const maxDy = last - tops[from]! - heights[from]!;
      const dy = Math.min(
        maxDy,
        Math.max(first - tops[from]!, event.clientY - current.startY),
      );
      const draggedCentre = tops[from]! + heights[from]! / 2;
      let to = from;
      for (let at = 0; at < cards.length; at += 1) {
        if (at === from) continue;
        const siblingCentre = tops[at]! + heights[at]! / 2;
        if (at > from) {
          const tallCard = heights[from]! > heights[at]!;
          const threshold = tallCard
            ? tops[at]! + heights[at]! - tops[from]! - heights[from]!
            : siblingCentre - draggedCentre;
          if (
            (tallCard ? dy >= threshold : dy > threshold) ||
            (at === cards.length - 1 && dy === maxDy)
          ) {
            to = Math.max(to, at);
          }
        } else {
          const threshold =
            heights[from]! > heights[at]!
              ? tops[at]! - tops[from]!
              : siblingCentre - draggedCentre;
          if (dy <= threshold) to = Math.min(to, at);
        }
      }
      current.to = to;
      cards[from]!.style.setProperty(SHIFT, `${dy}px`);
      cards.forEach((card, at) => {
        if (at === from) return;
        const shift =
          from < to && at > from && at <= to
            ? -stride
            : to < from && at >= to && at < from
              ? stride
              : 0;
        card.style.setProperty(SHIFT, `${shift}px`);
        card.toggleAttribute("data-making-room", shift !== 0);
      });
    },
    onPointerUp: (event) => {
      if (gesture.current?.pointerId === event.pointerId) end(true);
    },
    onPointerCancel: (event) => {
      if (gesture.current?.pointerId === event.pointerId) end(false);
    },
  });
}
