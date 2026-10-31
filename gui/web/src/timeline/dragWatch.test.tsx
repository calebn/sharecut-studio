import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { place, press } from "../test/hitDom";
import { BottomSheet } from "../ui/BottomSheet";
import { attachDragWatch } from "./dragWatch";
import { attachHitRouting, replayPointer } from "./hitRouting";
import { hitTargetProps } from "./hitTargets";

let root: HTMLDivElement;
let handle: HTMLButtonElement;
let captured: Set<number>;
let changes: boolean[];
let detach: () => void;

function fire(target: EventTarget, type: string, x: number, pointerId = 3) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId,
      pointerType: "touch",
      clientX: x,
      clientY: 50,
    }),
  );
}

beforeEach(() => {
  root = document.createElement("div");
  handle = document.createElement("button");
  root.append(handle);
  document.body.append(root);
  captured = new Set();
  // jsdom has no pointer capture; the owner under test captures by id.
  handle.hasPointerCapture = (id: number) => captured.has(id);
  changes = [];
  detach = attachDragWatch(root, (dragging) => changes.push(dragging));
});

afterEach(() => {
  detach();
  root.remove();
});

describe("attachDragWatch", () => {
  it("starts a drag once a captured pointer travels 3 px, and ends it on release", () => {
    fire(handle, "pointerdown", 100);
    captured.add(3);
    fire(handle, "pointermove", 102);
    expect(changes).toEqual([]);
    fire(handle, "pointermove", 103);
    fire(handle, "pointermove", 140);
    fire(handle, "pointerup", 140);
    expect(changes).toEqual([true, false]);
  });

  it("ignores a finger nothing captured: a scroll", () => {
    fire(handle, "pointerdown", 100);
    fire(handle, "pointermove", 160);
    fire(handle, "pointercancel", 160);
    expect(changes).toEqual([]);
  });

  it("ends on pointercancel and on lost capture", () => {
    captured.add(3);
    fire(handle, "pointerdown", 100);
    fire(handle, "pointermove", 120);
    fire(handle, "pointercancel", 120);
    captured.add(4);
    fire(handle, "pointerdown", 100, 4);
    fire(handle, "pointermove", 120, 4);
    fire(handle, "lostpointercapture", 120, 4);
    expect(changes).toEqual([true, false, true, false]);
  });

  it("counts a target the hit router grabbed, measured in its own moves", () => {
    const finger = new PointerEvent("pointerdown", {
      pointerId: 5,
      pointerType: "touch",
      clientX: 300,
      clientY: 40,
    });
    replayPointer("pointerdown", handle, finger, { x: 100, y: 50 });
    // The finger itself, 200 px away from the target, is not a move of it.
    fire(handle, "pointermove", 300, 5);
    expect(changes).toEqual([]);
    replayPointer("pointermove", handle, finger, { x: 104, y: 50 });
    replayPointer("pointerup", handle, finger, { x: 104, y: 50 });
    expect(changes).toEqual([true, false]);
  });

  it("ignores presses outside the timeline", () => {
    const outside = document.createElement("button");
    outside.hasPointerCapture = () => true;
    document.body.append(outside);
    fire(outside, "pointerdown", 100);
    fire(outside, "pointermove", 160);
    outside.remove();
    expect(changes).toEqual([]);
  });

  it.each(["pointerup", "pointercancel"] as const)(
    "keeps the inspector stowed through native capture transfer until replayed %s",
    (terminal) => {
      const sheet = (stowed: boolean) => (
        <BottomSheet
          open
          onClose={() => undefined}
          title="Inspector"
          backgroundPolicy="interactive"
          stowed={stowed}
        >
          <button type="button">Undo</button>
        </BottomSheet>
      );
      const view = render(sheet(false));
      detach();
      detach = attachDragWatch(root, (dragging) => {
        changes.push(dragging);
        view.rerender(sheet(dragging));
      });
      const finger = new PointerEvent("pointerdown", {
        pointerId: 5,
        pointerType: "touch",
        clientX: 300,
        clientY: 40,
      });
      const sheetRoot = document.querySelector(".bottom-sheet-root");
      const oldSource = document.createElement("div");
      root.append(oldSource);
      act(() => {
        replayPointer("pointerdown", handle, finger, { x: 100, y: 50 });
        replayPointer("pointermove", handle, finger, { x: 104, y: 50 });
      });
      expect(sheetRoot).toHaveAttribute("inert");
      act(() => {
        fire(oldSource, "lostpointercapture", 300, 5);
        replayPointer(
          terminal,
          handle,
          new PointerEvent("pointerdown", {
            pointerId: 6,
            pointerType: "touch",
          }),
        );
        replayPointer("pointermove", handle, finger, { x: 108, y: 50 });
      });
      expect(changes).toEqual([true]);
      expect(sheetRoot).toHaveClass("is-stowed");
      expect(sheetRoot).toHaveAttribute("inert");
      act(() => replayPointer(terminal, handle, finger, { x: 108, y: 50 }));
      expect(changes).toEqual([true, false]);
      expect(sheetRoot).not.toHaveClass("is-stowed");
      expect(sheetRoot).not.toHaveAttribute("inert");
    },
  );

  it("ends a real routed body drag when its owner disarms and loses capture", () => {
    for (const [name, value] of Object.entries(hitTargetProps("clip", "c1", 2)))
      handle.setAttribute(name, value);
    place(handle, { left: 194, top: 106, right: 206, bottom: 118 });
    const router = attachHitRouting(root);
    root.addEventListener(
      "pointerdown",
      (event) => {
        if (router.defers(event)) event.stopPropagation();
      },
      true,
    );
    try {
      press(handle, "pointerdown", 200, 112);
      router.longPress();
      press(handle, "pointermove", 230, 112);
      expect(changes).toEqual([true]);
      router.disarm(handle);
      press(handle, "lostpointercapture", 230, 112);
      expect(changes).toEqual([true, false]);
      press(handle, "pointerup", 230, 112);
      expect(changes).toEqual([true, false]);
    } finally {
      router.dispose();
    }
  });

  it("ends a replayed drag on its own owner's native capture loss", () => {
    const finger = new PointerEvent("pointerdown", { pointerId: 5 });
    replayPointer("pointerdown", handle, finger, { x: 100, y: 50 });
    replayPointer("pointermove", handle, finger, { x: 104, y: 50 });
    fire(handle, "lostpointercapture", 104, 5);
    expect(changes).toEqual([true, false]);
  });

  it.each(["pointerup", "pointercancel"])(
    "ends on native %s elsewhere after failed capture and ignores foreign IDs",
    (terminal) => {
      const finger = new PointerEvent("pointerdown", { pointerId: 5 });
      replayPointer("pointerdown", handle, finger, { x: 100, y: 50 });
      replayPointer("pointermove", handle, finger, { x: 104, y: 50 });
      expect(captured.size).toBe(0);
      fire(root, terminal, 300, 6);
      expect(changes).toEqual([true]);
      fire(root, terminal, 300, 5);
      expect(changes).toEqual([true, false]);
    },
  );

  it("ends when a disconnected replayed owner loses capture at the document", () => {
    const finger = new PointerEvent("pointerdown", { pointerId: 5 });
    replayPointer("pointerdown", handle, finger, { x: 100, y: 50 });
    replayPointer("pointermove", handle, finger, { x: 104, y: 50 });
    handle.remove();
    fire(document, "lostpointercapture", 104, 5);
    expect(changes).toEqual([true, false]);
  });

  it("unstows a live replayed drag when the timeline watch detaches", () => {
    const finger = new PointerEvent("pointerdown", { pointerId: 5 });
    replayPointer("pointerdown", handle, finger, { x: 100, y: 50 });
    replayPointer("pointermove", handle, finger, { x: 104, y: 50 });
    detach();
    detach = () => undefined;
    expect(changes).toEqual([true, false]);
    fire(handle, "pointerup", 104, 5);
    expect(changes).toEqual([true, false]);
  });
});
