import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HitRect } from "./hitCandidates";
import {
  attachHitRouting,
  CHOOSER_ITEM_ATTR,
  type ChooserView,
  type HitRouter,
} from "./hitRouting";
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
  pointerId = 7,
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType: "touch",
    isPrimary: pointerId === 7,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return event;
}

let root: HTMLDivElement;
let router: HitRouter;
let log: string[];
let views: (ChooserView | null)[];
let labOn: boolean;

function record(name: string, el: Element): void {
  for (const type of ["pointerdown", "pointermove", "pointerup", "click"]) {
    el.addEventListener(type, (e) => {
      const p = e as PointerEvent;
      log.push(`${name}:${type}@${p.clientX},${p.clientY}`);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  views = [];
  labOn = false;
  root = document.createElement("div");
  document.body.append(root);
  router = attachHitRouting(root, {
    chooserEnabled: () => labOn,
    onChooser: (view) => views.push(view),
  });
});

afterEach(() => {
  router.dispose();
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

/** The edge cluster from the first test: trim strip nearer, fade corner next. */
function edgeCluster() {
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
  return { trim, fade };
}

describe("touch chooser lab", () => {
  beforeEach(() => {
    labOn = true;
  });

  it("opens after a still 250 ms hold, ranked, without pressing any target", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    vi.advanceTimersByTime(249);
    expect(views).toEqual([]);
    press(fade, "pointermove", 206, 118);
    vi.advanceTimersByTime(1);

    expect(log).toEqual([]);
    expect(
      views.map((v) => ({
        kinds: v?.hits.map((h) => h.candidate.kind),
        fingerDown: v?.fingerDown,
        page: v?.page,
      })),
    ).toEqual([{ kinds: ["trim-in", "fade-in"], fingerDown: true, page: 0 }]);
  });

  it("drags the winner from the origin when the finger moves first", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    press(fade, "pointermove", 208, 117);
    vi.runAllTimers();

    expect(views).toEqual([]);
    expect(log).toEqual([
      "trim:pointerdown@204,117",
      "trim:pointermove@208,117",
    ]);
  });

  it("taps the winner on a quick lift", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    press(fade, "pointerup", 204, 117);
    fade.click();
    vi.runAllTimers();

    expect(views).toEqual([]);
    expect(log).toEqual([
      "trim:pointerdown@204,117",
      "trim:pointerup@204,117",
      "trim:click@204,117",
    ]);
  });

  it("stays open after a lift at the origin, then taps the picked target at its real place", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    vi.advanceTimersByTime(250);
    press(fade, "pointerup", 204, 117);
    expect(views.at(-1)?.fingerDown).toBe(false);

    const chipTap = press(document.body, "pointerup", 120, 40, 9);
    router.choose(1, chipTap);
    vi.runAllTimers();

    expect(views.at(-1)).toBeNull();
    expect(log).toEqual([
      "fade:pointerdown@206,112",
      "fade:pointerup@206,112",
      "fade:click@206,112",
    ]);
  });

  it("closes with no change on cancel, a second finger, or close()", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    vi.advanceTimersByTime(250);
    press(fade, "pointercancel", 204, 117);
    expect(views.at(-1)).toBeNull();

    press(fade, "pointerdown", 204, 117, 8);
    press(fade, "pointerdown", 260, 117, 9);
    vi.runAllTimers();
    expect(views.length).toBe(2);

    press(fade, "pointerdown", 204, 117, 10);
    vi.advanceTimersByTime(250);
    router.close();
    expect(views.at(-1)).toBeNull();
    expect(log).toEqual(["fade:pointerdown@260,117"]);
  });

  it("swallows the click of the tap that closed it", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    vi.advanceTimersByTime(250);
    press(fade, "pointerup", 204, 117);
    vi.advanceTimersByTime(1000);
    router.close();
    fade.click();
    expect(log).toEqual([]);
  });

  it("grabs a chip rested on for 250 ms and forwards the drag from the target", () => {
    const { fade } = edgeCluster();
    const chip = document.createElement("button");
    chip.setAttribute(CHOOSER_ITEM_ATTR, "1");
    document.body.append(chip);
    document.elementFromPoint = (x: number) => (x > 230 ? chip : null);

    press(fade, "pointerdown", 204, 117);
    vi.advanceTimersByTime(250);
    press(fade, "pointermove", 236, 53);
    vi.advanceTimersByTime(250);
    press(fade, "pointermove", 246, 53);
    press(fade, "pointerup", 246, 53);
    vi.runAllTimers();

    expect(views.at(-1)).toBeNull();
    expect(log).toEqual([
      "fade:pointerdown@206,112",
      "fade:pointermove@216,112",
      "fade:pointerup@216,112",
    ]);
    chip.remove();
  });
});
