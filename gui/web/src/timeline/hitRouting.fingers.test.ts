import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, press } from "../test/hitDom";
import {
  attachHitRouting,
  CHOOSER_ITEM_ATTR,
  type HitRouter,
  isReplayed,
} from "./hitRouting";
import { hitTargetProps } from "./hitTargets";

let scroll: HTMLDivElement;
let root: HTMLDivElement;
let router: HitRouter;
let log: string[];
let restored: number;
let chooserViews: unknown[];

function record(name: string, el: Element): void {
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
  ]) {
    el.addEventListener(type, (e) => {
      if (isReplayed(e)) log.push(`${name}:${type}`);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  restored = 0;
  chooserViews = [];
  scroll = document.createElement("div");
  scroll.className = "timeline-scroll";
  root = document.createElement("div");
  scroll.append(root);
  document.body.append(scroll);
  router = attachHitRouting(root, {
    onChooser: (view) => chooserViews.push(view),
    snapshot: () => () => {
      restored += 1;
    },
  });
  document.elementFromPoint = () => null;
  root.addEventListener(
    "pointerdown",
    (e) => {
      if (router.defers(e)) e.stopPropagation();
    },
    true,
  );
});

afterEach(() => {
  router.dispose();
  scroll.remove();
  vi.useRealTimers();
});

/** Two targets in reach at one spot, with the chooser's two chips above, outside the timeline. */
function crowdedWithChips() {
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
  const chips = ["0", "1"].map((index) => {
    const chip = document.createElement("button");
    chip.setAttribute(CHOOSER_ITEM_ATTR, index);
    document.body.append(chip);
    return chip;
  });
  document.elementFromPoint = (x: number, y: number) =>
    y > 80 ? null : x < 240 ? chips[0] : chips[1];
  return { trim, fade, chips };
}

/** A long press on the crowded spot opens the chooser; the finger lifts, leaving the chips open. */
function openChooser(fade: Element) {
  press(fade, "pointerdown", 204, 117);
  router.longPress();
  press(fade, "pointerup", 204, 117);
  log.length = 0;
  restored = 0;
}

describe("a second finger after the first began on a chooser chip", () => {
  it("cancels the armed target and puts the selection back, so the chip's lift saves nothing", () => {
    const { fade, chips } = crowdedWithChips();
    openChooser(fade);
    press(chips[1], "pointerdown", 250, 40, 9);
    vi.advanceTimersByTime(600);
    expect(log).toEqual(["fade:pointerdown"]);
    press(fade, "pointerdown", 300, 140, 10);
    expect(log).toEqual(["fade:pointerdown", "fade:pointercancel"]);
    expect(restored).toBe(1);
    press(chips[1], "pointerup", 250, 40, 9);
    press(fade, "pointerup", 300, 140, 10);
    vi.runAllTimers();
    for (const chip of chips) chip.remove();
    expect(log).toEqual(["fade:pointerdown", "fade:pointercancel"]);
  });

  it("drops the chip pick when the second finger lands before it rests", () => {
    const { fade, chips } = crowdedWithChips();
    openChooser(fade);
    press(chips[1], "pointerdown", 250, 40, 9);
    press(fade, "pointerdown", 300, 140, 10);
    expect(restored).toBe(1);
    press(chips[1], "pointerup", 250, 40, 9);
    press(fade, "pointerup", 300, 140, 10);
    vi.runAllTimers();
    for (const chip of chips) chip.remove();
    expect(log).toEqual([]);
    expect(chooserViews.at(-1)).toBeNull();
  });
});

describe("a router that adopts a part of the timeline outside its root", () => {
  it("rolls an armed grip back when a second finger lands on the lanes", () => {
    const rail = document.createElement("div");
    document.body.append(rail);
    const release = router.adopt(rail);
    const grip = button(hitTargetProps("crossfade-end", "clip-b", 9), {
      left: 600,
      top: 10,
      right: 610,
      bottom: 30,
    });
    rail.append(grip);
    record("grip", grip);
    const lane = button(hitTargetProps("chapter", "ch-1", 2), {
      left: 100,
      top: 100,
      right: 110,
      bottom: 120,
    });
    root.append(lane);
    record("lane", lane);

    press(grip, "pointerdown", 605, 20, 21);
    router.longPress();
    press(grip, "pointermove", 650, 20, 21);
    expect(log).toEqual(["grip:pointerdown", "grip:pointermove"]);
    press(lane, "pointerdown", 105, 110, 22);
    expect(log).toEqual([
      "grip:pointerdown",
      "grip:pointermove",
      "grip:pointercancel",
    ]);
    press(grip, "pointerup", 650, 20, 21);
    press(lane, "pointerup", 105, 110, 22);
    vi.runAllTimers();
    expect(log).toEqual([
      "grip:pointerdown",
      "grip:pointermove",
      "grip:pointercancel",
    ]);
    release();
    rail.remove();
  });

  it("stops routing the part once released", () => {
    const rail = document.createElement("div");
    document.body.append(rail);
    const release = router.adopt(rail);
    const grip = button(hitTargetProps("crossfade-end", "clip-b", 9), {
      left: 600,
      top: 10,
      right: 610,
      bottom: 30,
    });
    rail.append(grip);
    record("grip", grip);
    press(grip, "pointerdown", 605, 20, 21);
    router.longPress();
    press(grip, "pointerup", 605, 20, 21);
    expect(log).toEqual(["grip:pointerdown", "grip:pointerup"]);
    release();
    log.length = 0;
    press(grip, "pointerdown", 605, 20, 22);
    router.longPress();
    press(grip, "pointerup", 605, 20, 22);
    vi.runAllTimers();
    expect(log).toEqual([]);
    rail.remove();
  });
});

describe("a finger resting on the drawer", () => {
  function drawer(): { sheet: HTMLDivElement; header: Element } {
    const sheet = document.createElement("div");
    sheet.className = "bottom-sheet bottom-sheet--compact";
    const header = document.createElement("div");
    sheet.append(header);
    document.body.append(sheet);
    return { sheet, header };
  }

  it("counts as a first finger: a second finger's long press arms nothing and its lift saves nothing", () => {
    const { sheet, header } = drawer();
    const lone = button(hitTargetProps("chapter", "ch-1", 9), {
      left: 600,
      top: 10,
      right: 610,
      bottom: 30,
    });
    root.append(lone);
    record("lone", lone);
    press(header, "pointerdown", 100, 700, 20);
    press(lone, "pointerdown", 605, 20, 21);
    router.longPress();
    press(lone, "pointermove", 650, 20, 21);
    press(lone, "pointerup", 650, 20, 21);
    press(header, "pointerup", 100, 700, 20);
    vi.runAllTimers();
    sheet.remove();
    expect(log).toEqual([]);
    expect(restored).toBe(1);
  });

  it("leaves its own lone finger to the drawer", () => {
    const { sheet, header } = drawer();
    const own: string[] = [];
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      sheet.addEventListener(type, () => own.push(type));
    }
    press(header, "pointerdown", 100, 700, 20);
    press(header, "pointermove", 100, 650, 20);
    press(header, "pointerup", 100, 650, 20);
    sheet.remove();
    expect(own).toEqual(["pointerdown", "pointermove", "pointerup"]);
    expect(restored).toBe(0);
  });
});
