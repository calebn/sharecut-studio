import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HitRect } from "./hitCandidates";
import { attachHitRouting } from "./hitRouting";
import { HIT_SURFACE_PROPS, hitTargetProps } from "./hitTargets";

function place(element: Element, r: HitRect): void {
  element.getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
    }) as DOMRect;
}

function button(attrs: Record<string, string>, r: HitRect): HTMLButtonElement {
  const el = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  place(el, r);
  return el;
}

function press(
  target: Element,
  type: string,
  x: number,
  y: number,
  pointerType = "touch",
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType,
      isPrimary: true,
      clientX: x,
      clientY: y,
    }),
  );
}

let root: HTMLDivElement;
let detach: () => void;
let log: string[];

function record(name: string, el: Element): void {
  for (const type of ["pointerdown", "pointerup", "click"]) {
    el.addEventListener(type, (e) => {
      const p = e as PointerEvent;
      log.push(`${name}:${type}@${p.clientX},${p.clientY}`);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  root = document.createElement("div");
  document.body.append(root);
  detach = attachHitRouting(root);
});

afterEach(() => {
  detach();
  root.remove();
  vi.useRealTimers();
});

describe("attachHitRouting", () => {
  it("replays a crowded press, its release and its click on the nearest target", () => {
    const trim = button(hitTargetProps("trim-in", "clip-b", 2), {
      left: 200,
      top: 106,
      right: 208,
      bottom: 174,
    });
    const fade = button(hitTargetProps("fade-in", "clip-b", 2.3), {
      left: 200,
      top: 106,
      right: 212,
      bottom: 118,
    });
    root.append(trim, fade);
    record("trim", trim);
    record("fade", fade);

    // On the fade corner's box, but nearer the trim strip's centre line.
    press(fade, "pointerdown", 204, 117);
    press(fade, "pointerup", 204, 117);
    fade.click();
    vi.runAllTimers();

    expect(log).toEqual([
      "trim:pointerdown@204,117",
      "fade:pointerup@204,117",
      "trim:click@204,117",
    ]);
  });

  it("leaves a press with one target in reach alone", () => {
    const fade = button(hitTargetProps("fade-in", "clip-b", 2.3), {
      left: 200,
      top: 106,
      right: 212,
      bottom: 118,
    });
    const far = button(hitTargetProps("trim-out", "clip-c", 9), {
      left: 400,
      top: 106,
      right: 408,
      bottom: 174,
    });
    root.append(fade, far);
    record("fade", fade);
    record("far", far);

    press(fade, "pointerdown", 204, 110);
    press(fade, "pointerup", 204, 110);
    fade.click();
    vi.runAllTimers();

    expect(log).toEqual([
      "fade:pointerdown@204,110",
      "fade:pointerup@204,110",
      "fade:click@0,0",
    ]);
  });

  it("leaves a press on a plain surface alone", () => {
    const body = button(
      { ...HIT_SURFACE_PROPS },
      { left: 200, top: 106, right: 400, bottom: 174 },
    );
    const trim = button(hitTargetProps("trim-in", "clip-b", 2), {
      left: 200,
      top: 106,
      right: 208,
      bottom: 174,
    });
    const fade = button(hitTargetProps("fade-in", "clip-b", 2.3), {
      left: 200,
      top: 106,
      right: 212,
      bottom: 118,
    });
    root.append(body, trim, fade);
    record("body", body);
    record("trim", trim);

    press(body, "pointerdown", 214, 130);

    expect(log).toEqual(["body:pointerdown@214,130"]);
  });

  it("does not route a press outside the timeline", () => {
    const outside = button(hitTargetProps("trim-in", "clip-x", 2), {
      left: 200,
      top: 106,
      right: 208,
      bottom: 174,
    });
    const inside = button(hitTargetProps("fade-in", "clip-b", 2), {
      left: 200,
      top: 106,
      right: 212,
      bottom: 118,
    });
    document.body.append(outside);
    root.append(inside);
    record("outside", outside);
    record("inside", inside);

    press(outside, "pointerdown", 204, 117);

    expect(log).toEqual(["outside:pointerdown@204,117"]);
    outside.remove();
  });
});
