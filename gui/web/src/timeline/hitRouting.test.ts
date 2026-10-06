import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHIP_SETTLE_MS,
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
} from "../hooks/gestureConstants";
import type { HitRect } from "./hitCandidates";
import {
  attachHitRouting,
  CHOOSER_ITEM_ATTR,
  type ChooserView,
  type HitRouter,
  isReplayed,
  type RoutedTarget,
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
let targets: (RoutedTarget | null)[];
let labOn: boolean;
/** What the selection was rolled back to, once per pinch. */
let restored: string[];
let selection: string;
/** Log only what the router dispatched: the activations it decided. */
let onlyReplays: boolean;

function record(name: string, el: Element): void {
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "click",
  ]) {
    el.addEventListener(type, (e) => {
      if (onlyReplays && !isReplayed(e)) return;
      const p = e as PointerEvent;
      log.push(`${name}:${type}@${p.clientX},${p.clientY}`);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  views = [];
  targets = [];
  labOn = false;
  onlyReplays = false;
  restored = [];
  selection = "none";
  root = document.createElement("div");
  document.body.append(root);
  router = attachHitRouting(root, {
    touchLab: () => labOn,
    onChooser: (view) => views.push(view),
    onTarget: (target) => targets.push(target),
    snapshot: () => {
      const before = selection;
      return () => {
        selection = before;
        restored.push(before);
      };
    },
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

  it("cancels a drag when a second finger lands, and lets the pinch own both until they lift", () => {
    const fade = button(hitTargetProps("fade-in", "clip-b", 2.3), {
      left: 200,
      top: 106,
      right: 212,
      bottom: 118,
    });
    const surface = document.createElement("div");
    root.append(fade, surface);
    record("fade", fade);
    record("surface", surface);
    // The fade's own pointerdown selects its clip, as the handle does.
    fade.addEventListener("pointerdown", () => {
      selection = "clip-b";
    });

    press(fade, "pointerdown", 204, 117);
    press(fade, "pointermove", 230, 117);
    press(surface, "pointerdown", 320, 140, 8);
    press(fade, "pointermove", 180, 117);
    press(surface, "pointermove", 360, 140, 8);
    press(fade, "pointerup", 180, 117);
    // The first finger to lift is not a tap, though the other is still down.
    fade.click();
    press(surface, "pointerup", 360, 140, 8);
    fade.click();

    expect(log).toEqual([
      "fade:pointerdown@204,117",
      "fade:pointermove@230,117",
      "fade:pointercancel@204,117",
    ]);
    expect({ selection, restored }).toEqual({
      selection: "none",
      restored: ["none"],
    });

    // Once both lift, the next press is the target's again.
    log = [];
    press(fade, "pointerdown", 204, 117, 9);
    expect(log).toEqual(["fade:pointerdown@204,117"]);
  });

  it("cancels the target a crowded press was replayed on, not only the one pressed", () => {
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
    onlyReplays = true;

    press(fade, "pointerdown", 204, 117);
    press(trim, "pointerdown", 300, 140, 8);

    expect(log).toEqual([
      "trim:pointerdown@204,117",
      "trim:pointercancel@204,117",
    ]);
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
    onlyReplays = true;
    // jsdom does no layout: no chip is under any point unless a test says so.
    document.elementFromPoint = () => null;
    // What the press layer (useTouchPress) does with a deferred touch.
    root.addEventListener(
      "pointerdown",
      (e) => {
        if (router.defers(e)) e.stopPropagation();
      },
      true,
    );
  });

  it("hands an unselected touch to the press layer, pressing nothing while it moves", () => {
    const { fade } = edgeCluster();
    const down = press(fade, "pointerdown", 204, 117);
    press(fade, "pointermove", 260, 117);
    vi.runAllTimers();

    expect(router.defers(down)).toBe(true);
    expect(views).toEqual([]);
    expect(log).toEqual([]);
  });

  it("taps the winner on a release within the slop, while the pointer is live", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    press(fade, "pointerup", 206, 118);
    vi.runAllTimers();

    expect(log).toEqual([
      "trim:pointerdown@204,117",
      "trim:pointerup@204,117",
      "trim:click@204,117",
    ]);
  });

  it("drops a tap or hold whose finger slid past the slop", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    press(fade, "pointerup", 204 + TOUCH_SLOP_PX + 1, 117);
    press(fade, "pointerdown", 204, 117, 8);
    press(fade, "pointermove", 204, 117 + TOUCH_SLOP_PX + 1, 8);
    router.longPress();
    vi.runAllTimers();

    expect(views).toEqual([]);
    expect(log).toEqual([]);
  });

  it("drops a hold once a second finger joins, cancelling the press layer's press", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    press(fade, "pointerdown", 260, 117, 9);
    router.longPress();
    vi.runAllTimers();

    expect(views).toEqual([]);
    expect(log).toEqual(["fade:pointercancel@204,117"]);
  });

  it("closes an open chooser, and cancels a grabbed target, when a second finger lands", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    expect(views.at(-1)).not.toBeNull();
    press(fade, "pointerdown", 300, 140, 8);
    expect(views.at(-1)).toBeNull();
    press(fade, "pointerup", 204, 117);
    press(fade, "pointerup", 300, 140, 8);

    const lone = button(hitTargetProps("chapter", "ch-1", 9), {
      left: 600,
      top: 10,
      right: 610,
      bottom: 30,
    });
    root.append(lone);
    record("lone", lone);
    press(lone, "pointerdown", 605, 20, 10);
    router.longPress();
    press(lone, "pointermove", 640, 20, 10);
    press(lone, "pointerdown", 300, 140, 11);
    press(lone, "pointermove", 700, 20, 10);
    press(lone, "pointerup", 700, 20, 10);
    vi.runAllTimers();

    expect(log).toEqual([
      "fade:pointercancel@204,117",
      "lone:pointerdown@605,20",
      "lone:pointermove@640,20",
      "lone:pointercancel@605,20",
    ]);
  });

  it("opens the chooser on a long press over 2+ targets, ranked, without pressing any", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    router.longPress();

    expect(log).toEqual([]);
    expect(
      views.map((v) => ({
        kinds: v?.hits.map((h) => h.candidate.kind),
        fingerDown: v?.fingerDown,
      })),
    ).toEqual([{ kinds: ["trim-in", "fade-in"], fingerDown: true }]);
  });

  it("grabs a lone target on a long press; released in place, it is a tap", () => {
    const fade = button(hitTargetProps("fade-in", "clip-b", 2.3), {
      left: 200,
      top: 106,
      right: 212,
      bottom: 118,
    });
    root.append(fade);
    record("fade", fade);
    press(fade, "pointerdown", 206, 112);
    router.longPress();
    press(fade, "pointermove", 208, 112);
    press(fade, "pointerup", 208, 112);
    vi.runAllTimers();
    press(fade, "pointerdown", 206, 112, 8);
    router.longPress();
    press(fade, "pointermove", 240, 112, 8);
    press(fade, "pointerup", 240, 112, 8);
    vi.runAllTimers();

    expect(log).toEqual([
      "fade:pointerdown@206,112",
      "fade:pointermove@208,112",
      "fade:pointerup@208,112",
      "fade:click@208,112",
      "fade:pointerdown@206,112",
      "fade:pointermove@240,112",
      "fade:pointerup@240,112",
    ]);
  });

  it("lets a selected target under the finger take the touch at once", () => {
    onlyReplays = false;
    const { fade } = edgeCluster();
    fade.setAttribute("data-hit-selected", "true");
    const down = press(fade, "pointerdown", 204, 117);

    expect(router.defers(down)).toBe(false);
    expect(log).toEqual(["fade:pointerdown@204,117"]);
  });

  it("still defers a touch on an unselected target beside a selected one", () => {
    const { trim, fade } = edgeCluster();
    trim.setAttribute("data-hit-selected", "true");
    const down = press(fade, "pointerdown", 210, 112);
    expect(router.defers(down)).toBe(true);
    router.longPress();

    expect(views.at(-1)?.hits.map((h) => h.candidate.kind)).toEqual([
      "trim-in",
      "fade-in",
    ]);
  });

  it("leaves an armed Select range its touches", () => {
    const { fade } = edgeCluster();
    root.setAttribute("data-range-armed", "true");
    const down = press(fade, "pointerdown", 204, 117);

    expect(router.defers(down)).toBe(false);
  });

  it("stays open after the lift, then taps the picked target at its real place", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    press(fade, "pointerup", 204, 117);
    expect(views.at(-1)?.fingerDown).toBe(false);

    const chip = document.createElement("button");
    chip.setAttribute(CHOOSER_ITEM_ATTR, "1");
    document.body.append(chip);
    document.elementFromPoint = () => chip;
    press(chip, "pointerdown", 120, 40, 9);
    press(chip, "pointerup", 120, 40, 9);
    vi.runAllTimers();
    chip.remove();

    expect(views.at(-1)).toBeNull();
    expect(log).toEqual([
      "fade:pointerdown@206,112",
      "fade:pointerup@206,112",
      "fade:click@206,112",
    ]);
  });

  it("closes with no change on pointercancel or close()", () => {
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    press(fade, "pointercancel", 204, 117);
    expect(views.at(-1)).toBeNull();

    press(fade, "pointerdown", 204, 117, 10);
    router.longPress();
    router.close();
    expect(views.at(-1)).toBeNull();
    expect(log).toEqual([]);
  });

  it("swallows the click of the tap that closed it", () => {
    onlyReplays = false;
    const { fade } = edgeCluster();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    press(fade, "pointerup", 204, 117);
    vi.advanceTimersByTime(1000);
    router.close();
    fade.click();
    expect(log).toEqual([]);
  });

  it("marks a rested-on chip, then grabs it after a long press and drags from the target", () => {
    const { fade } = edgeCluster();
    const chip = document.createElement("button");
    chip.setAttribute(CHOOSER_ITEM_ATTR, "1");
    document.body.append(chip);
    document.elementFromPoint = (x: number) => (x > 230 ? chip : null);

    press(fade, "pointerdown", 204, 117);
    router.longPress();
    press(fade, "pointermove", 236, 53);
    expect(views.at(-1)?.over).toBe(1);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
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

  /** Two chips in a row: chip 0 left of x 240, chip 1 from there. */
  function chipRow() {
    const chips = ["0", "1"].map((index) => {
      const chip = document.createElement("button");
      chip.setAttribute(CHOOSER_ITEM_ATTR, index);
      document.body.append(chip);
      return chip;
    });
    document.elementFromPoint = (x: number, y: number) =>
      y > 80 ? null : x < 240 ? chips[0] : chips[1];
    return chips;
  }

  it("drags a settled chip's target on a slide along its axis, with no rest", () => {
    const { fade } = edgeCluster();
    const chips = chipRow();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    press(fade, "pointermove", 250, 53);
    expect(views.at(-1)).toMatchObject({ over: 1, armed: false });
    vi.advanceTimersByTime(CHIP_SETTLE_MS);
    expect(views.at(-1)).toMatchObject({ over: 1, armed: true });
    // 14 px right, 1 px down: along the fade's time axis.
    press(fade, "pointermove", 264, 54);
    press(fade, "pointerup", 274, 54);
    vi.runAllTimers();
    for (const chip of chips) chip.remove();

    expect(views.at(-1)).toBeNull();
    expect(targets).toEqual([{ kind: "fade-in", id: "clip-b" }]);
    // Offset from where the finger settled (250,53) to the fade (206,112).
    expect(log).toEqual([
      "fade:pointerdown@206,112",
      "fade:pointermove@220,113",
      "fade:pointerup@230,113",
    ]);
  });

  it("never grabs while the finger sweeps across the chips, or moves off the axis", () => {
    const { fade } = edgeCluster();
    const chips = chipRow();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    for (let x = 200; x <= 300; x += 12) {
      press(fade, "pointermove", x, 53);
      vi.advanceTimersByTime(16);
    }
    // Settled on chip 1, then straight down (off a time-only axis).
    vi.advanceTimersByTime(CHIP_SETTLE_MS);
    press(fade, "pointermove", 296, 70);
    expect(views.at(-1)).toMatchObject({ over: 1, armed: false });
    press(fade, "pointerup", 296, 70);
    vi.runAllTimers();
    for (const chip of chips) chip.remove();

    expect(log).toEqual([
      "fade:pointerdown@206,112",
      "fade:pointerup@206,112",
      "fade:click@206,112",
    ]);
  });

  it("drags a chip pressed again after the lift on its first slide along the axis", () => {
    const { fade } = edgeCluster();
    const chips = chipRow();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    press(fade, "pointerup", 204, 117);
    expect(views.at(-1)).toMatchObject({ fingerDown: false });

    press(chips[1], "pointerdown", 250, 40, 9);
    expect(views.at(-1)).toMatchObject({
      fingerDown: true,
      over: 1,
      armed: true,
    });
    press(chips[1], "pointermove", 262, 40, 9);
    press(chips[1], "pointerup", 270, 41, 9);
    vi.runAllTimers();
    for (const chip of chips) chip.remove();

    expect(log).toEqual([
      "fade:pointerdown@206,112",
      "fade:pointermove@218,112",
      "fade:pointerup@226,113",
    ]);
  });

  it("selects a chip pressed again and lifted without moving", () => {
    const { fade } = edgeCluster();
    const chips = chipRow();
    press(fade, "pointerdown", 204, 117);
    router.longPress();
    press(fade, "pointerup", 204, 117);
    press(chips[0], "pointerdown", 200, 40, 9);
    press(chips[0], "pointermove", 204, 41, 9);
    press(chips[0], "pointerup", 204, 41, 9);
    vi.runAllTimers();
    for (const chip of chips) chip.remove();

    expect(targets).toEqual([{ kind: "trim-in", id: "clip-b" }]);
    expect(log).toEqual([
      "trim:pointerdown@204,117",
      "trim:pointerup@204,117",
      "trim:click@204,117",
    ]);
  });

  it("cancels scrolling only while it owns the finger", () => {
    const { fade } = edgeCluster();
    const scroll = () => {
      const event = new Event("touchmove", { bubbles: true, cancelable: true });
      fade.dispatchEvent(event);
      return event.defaultPrevented;
    };
    press(fade, "pointerdown", 204, 117);
    const whilePressing = scroll();
    router.longPress();
    const whileOpen = scroll();

    expect({ whilePressing, whileOpen }).toEqual({
      whilePressing: false,
      whileOpen: true,
    });
  });
});
