import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoftBoundary } from "../edit/nudgeBoundaries";
import { DRAG_DETENT_PX } from "../hooks/gestureConstants";
import { button, press, surface } from "../test/hitDom";
import {
  ARMED_ATTR,
  type ArmedTarget,
  attachHitRouting,
  CREATE_ITEM_ATTR,
  type CreateView,
  type DetentView,
  type HitRouter,
  isReplayed,
} from "./hitRouting";
import {
  HIT_SURFACE_PROPS,
  hitTargetProps,
  OWN_TAP_HIT_SURFACE_PROPS,
} from "./hitTargets";

let root: HTMLDivElement;
let router: HitRouter;
let log: string[];
let armed: (ArmedTarget | null)[];
let creates: (CreateView | null)[];
let detents: (DetentView | null)[];
let restored: number;

function record(name: string, el: Element): void {
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "click",
  ]) {
    el.addEventListener(type, (e) => {
      if (!isReplayed(e)) return;
      const p = e as PointerEvent;
      log.push(`${name}:${type}@${p.clientX},${p.clientY}`);
    });
  }
}

/** A router like the timeline's: 100 px/s, `boundaries` for every target. */
function attach(
  boundaries: SoftBoundary[] = [],
  surfaceTaps: () => boolean = () => true,
): void {
  router?.dispose();
  router = attachHitRouting(root, {
    onArm: (target) => armed.push(target),
    onCreate: (view) => creates.push(view),
    onDetent: (detent) => detents.push(detent),
    detents: () => boundaries,
    pxPerSec: () => 100,
    surfaceTaps,
    snapshot: () => () => {
      restored += 1;
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  armed = [];
  creates = [];
  detents = [];
  restored = 0;
  root = document.createElement("div");
  document.body.append(root);
  document.elementFromPoint = () => null;
  // What the press layer (useTouchPress) does with a deferred touch.
  root.addEventListener(
    "pointerdown",
    (e) => {
      if (router.defers(e)) e.stopPropagation();
    },
    true,
  );
  attach();
});

afterEach(() => {
  router.dispose();
  root.remove();
  vi.useRealTimers();
});

/** A lone fade corner at 2 s: at 100 px/s, x 200 is 2 s. */
function loneFade(): HTMLButtonElement {
  const fade = button(hitTargetProps("fade-out", "clip-a", 2), {
    left: 194,
    top: 106,
    right: 206,
    bottom: 118,
  });
  root.append(fade);
  record("fade", fade);
  return fade;
}

function lane(top = 100): HTMLDivElement {
  const el = surface(HIT_SURFACE_PROPS, {
    left: 0,
    top,
    right: 800,
    bottom: top + 104,
  });
  root.append(el);
  record("lane", el);
  return el;
}

describe("arming", () => {
  it("marks an armed target until the lift, and names it with its axes", () => {
    const fade = loneFade();
    press(fade, "pointerdown", 200, 112);
    router.longPress();
    const marked = fade.hasAttribute(ARMED_ATTR);
    press(fade, "pointermove", 230, 112);
    press(fade, "pointerup", 230, 112);

    expect(marked).toBe(true);
    expect(fade.hasAttribute(ARMED_ATTR)).toBe(false);
    expect(armed).toEqual([
      { kind: "fade-out", id: "clip-a", axis: "x" },
      null,
    ]);
  });

  it("disarms only the element whose owner cancelled, and ignores the lift", () => {
    const fade = loneFade();
    const other = document.createElement("div");
    press(fade, "pointerdown", 200, 112);
    router.longPress();
    router.disarm(other);
    const stillArmed = fade.hasAttribute(ARMED_ATTR);
    router.disarm(fade);
    const cleared = !fade.hasAttribute(ARMED_ATTR);
    press(fade, "pointermove", 230, 112);
    press(fade, "pointerup", 230, 112);

    expect(stillArmed).toBe(true);
    expect(cleared).toBe(true);
    expect(armed).toEqual([
      { kind: "fade-out", id: "clip-a", axis: "x" },
      null,
    ]);
  });
});

describe("drag detents", () => {
  it("holds an armed drag at a soft boundary, then follows a push past it", () => {
    attach([{ sec: 2.5, label: "the playhead" }]);
    const fade = loneFade();
    press(fade, "pointerdown", 200, 112);
    router.longPress();
    // 2.5 s is x 250: short of it, onto it, held inside the detent, then past.
    for (const x of [
      240,
      252,
      250 + DRAG_DETENT_PX,
      250 + DRAG_DETENT_PX + 4,
    ]) {
      press(fade, "pointermove", x, 112);
    }
    press(fade, "pointerup", 280, 112);

    expect(log).toEqual([
      "fade:pointerdown@200,112",
      "fade:pointermove@240,112",
      "fade:pointermove@250,112",
      "fade:pointermove@250,112",
      `fade:pointermove@${250 + DRAG_DETENT_PX + 4},112`,
      "fade:pointerup@280,112",
    ]);
    expect(detents).toEqual([
      { x: 250, boundary: { sec: 2.5, label: "the playhead" } },
      null,
    ]);
  });

  it("does not catch on a boundary the drag starts on", () => {
    attach([{ sec: 2, label: "a clip edge" }]);
    const fade = loneFade();
    press(fade, "pointerdown", 200, 112);
    router.longPress();
    press(fade, "pointermove", 206, 112);
    press(fade, "pointerup", 206, 112);

    expect(detents).toEqual([]);
    expect(log.at(-1)).toBe("fade:pointerup@206,112");
  });

  it("lets go of a held detent when the drag is cancelled", () => {
    attach([{ sec: 2.5, label: "the playhead" }]);
    const fade = loneFade();
    press(fade, "pointerdown", 200, 112);
    router.longPress();
    press(fade, "pointermove", 252, 112);
    press(fade, "pointerdown", 500, 140, 8);

    expect(detents.at(-1)).toBeNull();
    expect(log.at(-1)).toBe("fade:pointercancel@200,112");
  });
});

/** A clip body from 1 s to 5 s: x 100 to 500 at 100 px/s. */
function clipBody(): HTMLButtonElement {
  const el = button(hitTargetProps("clip", "clip-b", 1, { spanSec: 4 }), {
    left: 100,
    top: 106,
    right: 500,
    bottom: 206,
  });
  root.append(el);
  record("clip", el);
  return el;
}

describe("clip body", () => {
  it("arms on a long press, not the create menu, and moves in time only", () => {
    const el = clipBody();
    press(el, "pointerdown", 300, 150);
    router.longPress();
    press(el, "pointermove", 260, 190);
    press(el, "pointerup", 260, 190);

    expect(creates).toEqual([]);
    expect(armed).toEqual([{ kind: "clip", id: "clip-b", axis: "x" }, null]);
    expect(log).toEqual([
      "clip:pointerdown@300,150",
      "clip:pointermove@260,150",
      "clip:pointerup@260,150",
    ]);
  });

  it("arms from its body near an end whose trim and fade targets are click-through, as on an unselected clip", () => {
    const el = clipBody();
    for (const [kind, rect] of [
      ["trim-out", { left: 488, top: 106, right: 500, bottom: 206 }],
      ["fade-out", { left: 476, top: 106, right: 500, bottom: 130 }],
    ] as const) {
      const target = button(hitTargetProps(kind, "clip-b", 5), rect);
      target.style.pointerEvents = "none";
      root.append(target);
    }
    press(el, "pointerdown", 490, 150);
    router.longPress();
    press(el, "pointermove", 450, 150);
    press(el, "pointerup", 450, 150);

    expect(creates).toEqual([]);
    expect(armed).toEqual([{ kind: "clip", id: "clip-b", axis: "x" }, null]);
  });

  it("holds when its far end meets a boundary, and marks the boundary", () => {
    attach([{ sec: 5.5, label: "a clip edge" }]);
    const el = clipBody();
    press(el, "pointerdown", 300, 150);
    router.longPress();
    // The end (5 s) reaches 5.5 s once the finger has gone 50 px.
    press(el, "pointermove", 340, 150);
    press(el, "pointermove", 356, 150);
    press(el, "pointerup", 356, 150);

    expect(log).toEqual([
      "clip:pointerdown@300,150",
      "clip:pointermove@340,150",
      "clip:pointermove@350,150",
      "clip:pointerup@350,150",
    ]);
    expect(detents).toEqual([
      { x: 550, boundary: { sec: 5.5, label: "a clip edge" } },
      null,
    ]);
  });

  it("leaves a long press to a target in reach, but keeps its tap", () => {
    const el = clipBody();
    const fade = button(hitTargetProps("fade-in", "clip-b", 1.2), {
      left: 314,
      top: 144,
      right: 326,
      bottom: 156,
    });
    root.append(fade);
    record("fade", fade);
    press(el, "pointerdown", 300, 150);
    press(el, "pointerup", 300, 150);
    vi.runAllTimers();
    press(el, "pointerdown", 300, 150);
    router.longPress();

    expect(log).toEqual([
      "clip:pointerdown@300,150",
      "clip:pointerup@300,150",
      "clip:click@300,150",
      "fade:pointerdown@320,150",
    ]);
    expect(armed).toEqual([{ kind: "fade-in", id: "clip-b", axis: "x" }]);
  });
});

describe("tap on a surface near an edit mark", () => {
  function mark(kind: "join" | "edit-chip" = "join"): HTMLButtonElement {
    const el = button(hitTargetProps(kind, "clip-b", 2), {
      left: 192,
      top: 100,
      right: 208,
      bottom: 108,
    });
    root.append(el);
    record(kind, el);
    return el;
  }

  function tap(el: Element, x: number, y: number, type = "touch"): void {
    press(el, "pointerdown", x, y, 7, type);
    press(el, "pointerup", x, y, 7, type);
  }

  const seeks = () => log.filter((entry) => entry.startsWith("lane:"));
  const marks = (name: string) =>
    log.filter((entry) => entry.startsWith(`${name}:`));

  const nativeClick = (el: Element, x: number, y: number) =>
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }),
    );

  function opensFromClick(kind: "join" | "edit-chip"): void {
    const el = lane();
    mark(kind);
    tap(el, 228, 104);
    const before = marks(kind);
    nativeClick(el, 228, 104);

    expect(before).toEqual([]);
    expect(marks(kind)).toEqual([`${kind}:click@228,104`]);
    expect(seeks()).toEqual([]);
  }

  it("opens the join from the browser's click when a finger lands 20 px beside it", () => {
    opensFromClick("join");
  });

  it("opens the edit chip from the browser's click when a finger lands 20 px beside it", () => {
    opensFromClick("edit-chip");
  });

  it("opens the mark once when no browser click follows the tap", () => {
    const el = lane();
    mark();
    tap(el, 228, 104);
    vi.runAllTimers();

    expect(marks("join")).toEqual(["join:click@228,104"]);
    expect(router.claimsClick(new MouseEvent("click"))).toBe(false);
  });

  it("drops a pending tap when the next press starts", () => {
    const el = lane();
    mark();
    tap(el, 228, 104);
    press(el, "pointerdown", 600, 104);
    vi.runAllTimers();

    expect(marks("join")).toEqual([]);
  });

  it("claims the browser's own click on the surface after a tap sent to a mark, once", () => {
    const el = lane();
    mark();
    tap(el, 228, 104);
    const claims: boolean[] = [];
    el.addEventListener("click", (e) => claims.push(router.claimsClick(e)));
    nativeClick(el, 228, 104);
    nativeClick(el, 228, 104);

    expect(claims).toEqual([true, false]);
    expect(marks("join").at(-1)).toBe("join:click@228,104");
  });

  it("does not claim a click after a tap that stayed on its own target", () => {
    const el = lane();
    const claims: boolean[] = [];
    el.addEventListener("click", (e) => claims.push(router.claimsClick(e)));
    tap(el, 600, 104);
    vi.runAllTimers();
    nativeClick(el, 600, 104);

    expect(claims).toEqual([false, false]);
  });

  it("does not claim the replayed click or the next press's click", () => {
    const el = lane();
    const target = mark();
    const claims: boolean[] = [];
    target.addEventListener("click", (e) => claims.push(router.claimsClick(e)));
    tap(el, 228, 104);
    vi.runAllTimers();
    tap(el, 600, 104);
    nativeClick(el, 600, 104);

    expect(claims).toEqual([false]);
    expect(router.claimsClick(new MouseEvent("click"))).toBe(false);
  });

  it("goes to the mark down to 44 px under its top", () => {
    const el = lane();
    mark();
    tap(el, 200, 144);
    nativeClick(el, 200, 144);

    expect(marks("join")).toEqual(["join:click@200,144"]);
    expect(seeks()).toEqual([]);
  });

  it("stays with a pending region or the envelope that owns its tap, even beside a join", () => {
    const region = surface(OWN_TAP_HIT_SURFACE_PROPS, {
      left: 0,
      top: 100,
      right: 800,
      bottom: 204,
    });
    root.append(region);
    record("pending", region);
    mark();
    tap(region, 228, 104);

    expect(marks("join")).toEqual([]);
    expect(marks("pending")).toEqual([
      "pending:pointerdown@228,104",
      "pending:pointerup@228,104",
    ]);
  });

  it("stays a seek 30 px beside the mark", () => {
    const el = lane();
    mark();
    tap(el, 238, 104);

    expect(marks("join")).toEqual([]);
    expect(seeks()).toEqual([
      "lane:pointerdown@238,104",
      "lane:pointerup@238,104",
    ]);
  });

  it("stays a seek lower in the lane, under the mark", () => {
    const el = lane();
    mark();
    tap(el, 200, 160);

    expect(marks("join")).toEqual([]);
    expect(seeks()).toHaveLength(2);
  });

  it("stays a seek in the lane above, where the mark's box would reach", () => {
    const above = lane(-4);
    mark();
    tap(above, 200, 90);

    expect(marks("join")).toEqual([]);
    expect(seeks()).toEqual([
      "lane:pointerdown@200,90",
      "lane:pointerup@200,90",
    ]);
  });

  it("stays a seek under a chip", () => {
    const el = lane();
    mark("edit-chip");
    tap(el, 200, 170);

    expect(marks("edit-chip")).toEqual([]);
    expect(seeks()).toHaveLength(2);
  });

  it("never takes a mouse click, which has no finger to miss with", () => {
    const el = lane();
    mark();
    tap(el, 228, 104, "mouse");

    expect(marks("join")).toEqual([]);
  });

  it("leaves the tap to the surface in blade mode", () => {
    attach([], () => false);
    const el = lane();
    mark();
    tap(el, 228, 104);

    expect(marks("join")).toEqual([]);
    expect(seeks()).toHaveLength(2);
  });

  it("gives a press on a trim handle at the same seam to the handle", () => {
    const el = lane();
    mark();
    const handle = button(hitTargetProps("trim-in", "clip-b", 2), {
      left: 196,
      top: 104,
      right: 204,
      bottom: 160,
    });
    root.append(handle);
    record("trim", handle);
    tap(handle, 200, 130);

    expect(marks("trim")).toEqual([
      "trim:pointerdown@200,130",
      "trim:pointerup@200,130",
    ]);
    expect(marks("join")).toEqual([]);
    expect(seeks()).toEqual([]);
    expect(el.isConnected).toBe(true);
  });

  it("opens the create menu on a long press 30 px beside the mark", () => {
    const el = lane();
    mark();
    press(el, "pointerdown", 238, 104);
    router.longPress();

    expect(creates.at(-1)?.surface).toBe(el);
    expect(marks("join")).toEqual([]);
  });

  it("opens the create menu on a long press in the lane above", () => {
    const above = lane(-4);
    mark();
    press(above, "pointerdown", 200, 70);
    router.longPress();

    expect(creates.at(-1)?.surface).toBe(above);
  });

  it("lets a trim handle win a press on it while a glyph holds focus", () => {
    const el = lane();
    const glyph = mark();
    const handle = button(hitTargetProps("trim-in", "clip-b", 2), {
      left: 196,
      top: 104,
      right: 204,
      bottom: 160,
    });
    root.append(handle);
    record("trim", handle);
    glyph.focus();
    press(handle, "pointerdown", 200, 130);
    press(handle, "pointerup", 200, 130);

    expect(marks("trim")).toEqual([
      "trim:pointerdown@200,130",
      "trim:pointerup@200,130",
    ]);
    expect(marks("join")).toEqual([]);
    expect(el.isConnected).toBe(true);
  });
});

describe("create menu", () => {
  it("opens on a long press over empty space; a lift leaves it open", () => {
    const el = lane();
    press(el, "pointerdown", 400, 150);
    router.longPress();
    press(el, "pointermove", 404, 150);
    press(el, "pointerup", 404, 150);

    expect(log).toEqual([]);
    expect(
      creates.map((v) => v && { origin: v.origin, fingerDown: v.fingerDown }),
    ).toEqual([
      { origin: { x: 400, y: 150 }, fingerDown: true },
      { origin: { x: 400, y: 150 }, fingerDown: false },
    ]);
    expect(creates[0]?.surface).toBe(el);

    router.close();
    expect(creates.at(-1)).toBeNull();
  });

  it("picks the item the finger slides onto and lifts on", () => {
    const el = lane();
    const item = document.createElement("button");
    item.setAttribute(CREATE_ITEM_ATTR, "1");
    document.body.append(item);
    const picked: string[] = [];
    item.addEventListener("click", () => picked.push("item"));
    document.elementFromPoint = (_x: number, y: number) =>
      y < 90 ? item : null;

    press(el, "pointerdown", 400, 150);
    router.longPress();
    press(el, "pointermove", 400, 80);
    const over = creates.at(-1)?.over;
    press(el, "pointerup", 400, 80);
    item.remove();

    expect(over).toBe(1);
    expect(picked).toEqual(["item"]);
    expect(creates.at(-1)).toBeNull();
  });

  it("picks nothing when the finger lifts without moving onto an item, whatever is under it", () => {
    const el = lane();
    const item = document.createElement("button");
    item.setAttribute(CREATE_ITEM_ATTR, "2");
    document.body.append(item);
    const picked: string[] = [];
    item.addEventListener("click", () => picked.push("item"));
    document.elementFromPoint = () => item;

    press(el, "pointerdown", 400, 150);
    router.longPress();
    press(el, "pointermove", 404, 152);
    const overWhileWithinSlop = creates.at(-1)?.over;
    press(el, "pointerup", 404, 152);
    vi.runAllTimers();
    const afterLift = creates.at(-1);
    item.remove();

    expect(overWhileWithinSlop).toBeNull();
    expect(picked).toEqual([]);
    expect(afterLift).toMatchObject({ fingerDown: false, over: null });
  });

  it("picks the item once the finger has moved past the slop onto it", () => {
    const el = lane();
    const item = document.createElement("button");
    item.setAttribute(CREATE_ITEM_ATTR, "2");
    document.body.append(item);
    const picked: string[] = [];
    item.addEventListener("click", () => picked.push("item"));
    document.elementFromPoint = () => item;

    press(el, "pointerdown", 400, 150);
    router.longPress();
    press(el, "pointermove", 400, 160);
    const over = creates.at(-1)?.over;
    press(el, "pointerup", 400, 160);
    vi.runAllTimers();
    item.remove();

    expect(over).toBe(2);
    expect(picked).toEqual(["item"]);
  });

  it("keeps the page from scrolling while the finger that opened it is down", () => {
    const el = lane();
    const scroll = () => {
      const event = new Event("touchmove", { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    press(el, "pointerdown", 400, 150);
    router.longPress();
    const whileDown = scroll();
    press(el, "pointerup", 400, 150);

    expect({ whileDown, afterLift: scroll() }).toEqual({
      whileDown: true,
      afterLift: false,
    });
  });

  it("closes when a second finger lands off the timeline, on its scrim", () => {
    const el = lane();
    const scrim = document.createElement("div");
    document.body.append(scrim);
    press(el, "pointerdown", 400, 150);
    router.longPress();
    press(scrim, "pointerdown", 600, 150, 8);
    scrim.remove();

    expect(creates.at(-1)).toBeNull();
    expect(restored).toBe(1);
  });

  it("closes, with the selection put back, when a second finger lands", () => {
    const el = lane();
    press(el, "pointerdown", 400, 150);
    router.longPress();
    press(el, "pointerdown", 600, 150, 8);

    expect(creates.at(-1)).toBeNull();
    expect(restored).toBe(1);
  });
});

describe("context menu (#1793)", () => {
  function contextmenu(
    target: Element,
    x: number,
    y: number,
    init: { pointerType?: string } = {},
  ): MouseEvent {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    if (init.pointerType) {
      Object.defineProperty(event, "pointerType", { value: init.pointerType });
    }
    target.dispatchEvent(event);
    return event;
  }

  it("opens the create menu where a right click lands", () => {
    const el = lane();
    const event = contextmenu(el, 400, 150);

    expect(event.defaultPrevented).toBe(true);
    expect(creates.at(-1)?.origin).toEqual({ x: 400, y: 150 });
  });

  it("leaves a touch contextmenu to the long press", () => {
    const el = lane();
    const event = contextmenu(el, 400, 150, { pointerType: "touch" });

    expect(event.defaultPrevented).toBe(false);
    expect(creates).toEqual([]);
  });

  it("opens nothing on a contextmenu while a press is under way", () => {
    const el = lane();
    press(el, "pointerdown", 300, 150);
    const whilePressing = contextmenu(el, 400, 150);

    expect(whilePressing.defaultPrevented).toBe(false);
    expect(creates).toEqual([]);
  });

  it("keeps the native menu off an open create menu when the key press has no target, and moves the menu on a right click", () => {
    const el = lane();
    router.openCreate({ x: 300, y: 150 }, el);
    const keyed = contextmenu(document.body, 0, 0);
    const moved = contextmenu(el, 500, 150);

    expect({
      keyed: keyed.defaultPrevented,
      moved: moved.defaultPrevented,
    }).toEqual({
      keyed: true,
      moved: true,
    });
    expect(creates.at(-1)?.origin).toEqual({ x: 500, y: 150 });
  });

  it("reports whether the menu opened", () => {
    const el = lane();
    press(el, "pointerdown", 300, 150);

    expect(router.openCreate({ x: 300, y: 150 }, el)).toBe(false);
  });
});
