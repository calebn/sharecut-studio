import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TARGET_ID_ATTR } from "../stages/edit/chooserKinds";
import { button, press } from "../test/hitDom";
import { attachHitRouting, type HitRouter, isReplayed } from "./hitRouting";
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
    chip.setAttribute(TARGET_ID_ATTR, index);
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
    press(chips[1], "pointermove", 266, 40, 9);
    expect(log).toEqual(["fade:pointerdown", "fade:pointermove"]);
    press(fade, "pointerdown", 300, 140, 10);
    expect(log).toEqual([
      "fade:pointerdown",
      "fade:pointermove",
      "fade:pointercancel",
    ]);
    expect(restored).toBe(1);
    press(chips[1], "pointerup", 250, 40, 9);
    press(fade, "pointerup", 300, 140, 10);
    vi.runAllTimers();
    for (const chip of chips) chip.remove();
    expect(log).toEqual([
      "fade:pointerdown",
      "fade:pointermove",
      "fade:pointercancel",
    ]);
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

describe("a finger resting on the Inspector sheet", () => {
  function drawer(): { sheet: HTMLDivElement; header: Element } {
    const sheet = document.createElement("div");
    sheet.className = "sys-inspector--phone";
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

  it("leaves its own lone finger to the sheet", () => {
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
