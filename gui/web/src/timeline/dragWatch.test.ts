import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachDragWatch } from "./dragWatch";
import { replayPointer } from "./hitRouting";

let root: HTMLDivElement;
let handle: HTMLButtonElement;
let captured: Set<number>;
let changes: boolean[];
let detach: () => void;

function fire(target: Element, type: string, x: number, pointerId = 3) {
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
});
