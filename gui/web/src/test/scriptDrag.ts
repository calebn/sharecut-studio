import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

const MOUSE = { pointerId: 1, pointerType: "mouse", isPrimary: true } as const;
const rectAt = (at: number) =>
  new DOMRect((at % 5) * 60, Math.floor(at / 5) * 26, 50, 20);
const rectOf = (el: HTMLElement) => {
  const at = Number(el.dataset.stop);
  return Number.isNaN(at) ? new DOMRect(0, 0, 0, 0) : rectAt(at);
};
const centre = (index: number) => {
  const r = rectAt(index);
  return { clientX: r.x + 25, clientY: r.y + 10 };
};
export const stop = (index: number) =>
  document.querySelector(`[data-stop="${index}"]`) as HTMLElement;

export function layout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("sys-script-body")
        ? new DOMRect(0, 0, 300, 200)
        : rectOf(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return [rectOf(this)] as unknown as DOMRectList;
    },
  );
  document.elementFromPoint = (x: number, y: number) => {
    const column = Math.floor(x / 60);
    const at = Math.floor(y / 26) * 5 + column;
    if (x % 60 >= 50 || y % 26 >= 20 || column > 4) return null;
    return document.querySelector(`[data-stop="${at}"]`);
  };
}

export const drag = (from: number, to: number) => {
  fireEvent.pointerDown(stop(from), { ...MOUSE, ...centre(from) });
  fireEvent.pointerMove(stop(from), {
    ...MOUSE,
    ...centre(from),
    clientX: 100,
  });
  fireEvent.pointerMove(stop(from), { ...MOUSE, ...centre(to) });
  fireEvent.pointerUp(document.querySelector(".sys-script-body") as Element, {
    ...MOUSE,
    ...centre(to),
  });
};
