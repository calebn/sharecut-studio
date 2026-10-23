import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberPressedControl } from "../ui/pressedControl";
import { toastDockBottomPx, useToastDock } from "./toastDock";

/** 390×844 phone: transport 0–52, mode nav 792–844, toast 62 tall, 12px gap. */
const phone = {
  viewportHeight: 844,
  ceilingPx: 52,
  restTopPx: 792,
  toastHeightPx: 62,
  gapPx: 12,
};

describe("toastDockBottomPx (phone)", () => {
  it("sits just above the mode nav when nothing else is docked", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792] })).toBe(
      844 - 792 + 12,
    );
  });

  it("sits above the Timeline tool rail instead of covering it", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792, 732] })).toBe(
      844 - 732 + 12,
    );
  });

  it("sits above a half sheet, over the timeline, under the transport", () => {
    const bottom = toastDockBottomPx({
      ...phone,
      floorTopsPx: [792, 732, 396],
    });
    expect(bottom).toBe(844 - 396 + 12);
    const toastTop = 844 - bottom - phone.toastHeightPx;
    expect(toastTop).toBeGreaterThanOrEqual(phone.ceilingPx);
  });

  it("falls back above the mode nav when a full sheet leaves no free band", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792, 732, 0] })).toBe(
      844 - 792 + 12,
    );
  });

  it("falls back when the band above a tall sheet cannot fit the toast", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792, 100] })).toBe(
      844 - 792 + 12,
    );
  });

  it("moves above the control just pressed when the full-sheet spot covers it", () => {
    // Full sheet: the fallback spot is 718–780; "Move track down" is 730–774.
    const bottom = toastDockBottomPx({
      ...phone,
      floorTopsPx: [792, 0],
      pressedPx: { top: 730, bottom: 774 },
    });
    expect(bottom).toBe(844 - 730 + 12);
    expect(844 - bottom).toBeLessThanOrEqual(730);
  });

  it("moves below the control just pressed when there is no room above it", () => {
    // A tall status area (ceiling 280) over a sheet at 500: the spot is 426–488.
    const bottom = toastDockBottomPx({
      ...phone,
      ceilingPx: 280,
      floorTopsPx: [792, 500],
      pressedPx: { top: 290, bottom: 440 },
    });
    expect(bottom).toBe(844 - (440 + 12 + 62));
  });

  it("keeps its spot when the control just pressed is clear of it", () => {
    expect(
      toastDockBottomPx({
        ...phone,
        floorTopsPx: [792, 0],
        pressedPx: { top: 300, bottom: 344 },
      }),
    ).toBe(844 - 792 + 12);
  });

  it("keeps its spot when a pressed control fills the whole band", () => {
    expect(
      toastDockBottomPx({
        ...phone,
        floorTopsPx: [792, 0],
        pressedPx: { top: 60, bottom: 780 },
      }),
    ).toBe(844 - 792 + 12);
  });
});

describe("toastDockBottomPx keeps body controls clear (#1960)", () => {
  /** 320×460: status row 0–20, dock top 295, nav 408; Listen's Play row 205–261. */
  const short = {
    viewportHeight: 460,
    ceilingPx: 20,
    floorTopsPx: [408, 295],
    restTopPx: 408,
    toastHeightPx: 62,
    gapPx: 8,
  };
  const playRow = { top: 205, bottom: 261 };

  it("moves above the Play row when the dock spot would land on it", () => {
    const bottom = toastDockBottomPx({ ...short, keepClearPx: [playRow] });
    expect(bottom).toBe(460 - (205 - 8));
    expect(460 - bottom).toBeLessThanOrEqual(playRow.top);
  });

  it("keeps the dock spot when the Play row is clear of it", () => {
    expect(
      toastDockBottomPx({
        ...short,
        viewportHeight: 520,
        floorTopsPx: [468, 355],
        restTopPx: 468,
        keepClearPx: [playRow],
      }),
    ).toBe(520 - 355 + 8);
  });

  it("moves below the Play row when there is no room above it", () => {
    const bottom = toastDockBottomPx({
      ...short,
      ceilingPx: 150,
      keepClearPx: [playRow],
    });
    expect(bottom).toBe(460 - (261 + 8 + 62));
  });

  it("keeps the dock spot when neither side of the Play row has room", () => {
    expect(
      toastDockBottomPx({
        ...short,
        ceilingPx: 150,
        floorTopsPx: [408],
        keepClearPx: [{ top: 160, bottom: 400 }],
      }),
    ).toBe(460 - 408 + 8);
  });

  it("clears both the pressed control and the Play row", () => {
    // Above the Play row lands on the pressed control, so the toast goes above that.
    const bottom = toastDockBottomPx({
      ...short,
      pressedPx: { top: 130, bottom: 190 },
      keepClearPx: [playRow],
    });
    expect(bottom).toBe(460 - (130 - 8));
  });
});

describe("toastDockBottomPx keeps the comment field and name step clear (#2199)", () => {
  const landscape = {
    viewportHeight: 390,
    ceilingPx: 0,
    floorTopsPx: [],
    restTopPx: 362,
    toastHeightPx: 62,
    gapPx: 8,
  };
  const composer = { top: 306, bottom: 354 };

  it("rests above the status bar when no field is under it", () => {
    expect(toastDockBottomPx(landscape)).toBe(390 - 362 + 8);
  });

  it("moves above the composer when the resting spot would cover it", () => {
    const bottom = toastDockBottomPx({ ...landscape, protectPx: [composer] });
    expect(bottom).toBe(390 - (306 - 8));
  });

  it("moves below the composer when there is no room above it", () => {
    const bottom = toastDockBottomPx({
      ...landscape,
      protectPx: [{ top: 20, bottom: 300 }],
    });
    expect(bottom).toBe(390 - (300 + 8 + 62));
  });

  it("clears the composer even when that passes the ceiling", () => {
    const bottom = toastDockBottomPx({
      viewportHeight: 340,
      ceilingPx: 90,
      floorTopsPx: [288, 120],
      restTopPx: 288,
      toastHeightPx: 62,
      gapPx: 8,
      protectPx: [{ top: 120, bottom: 250 }],
    });
    expect(bottom).toBe(340 - (120 - 8));
  });

  it("keeps the resting spot when the field is clear of it", () => {
    expect(
      toastDockBottomPx({
        ...landscape,
        protectPx: [{ top: 100, bottom: 200 }],
      }),
    ).toBe(390 - 362 + 8);
  });

  it("passes the ceiling to clear a Play row as well as the field", () => {
    expect(
      toastDockBottomPx({
        viewportHeight: 400,
        ceilingPx: 150,
        floorTopsPx: [],
        restTopPx: 380,
        toastHeightPx: 62,
        gapPx: 8,
        keepClearPx: [{ top: 300, bottom: 370 }],
        protectPx: [{ top: 200, bottom: 260 }],
      }),
    ).toBe(400 - (200 - 8));
  });

  it("relaxes other controls only after no position clears them with the protected field", () => {
    expect(
      toastDockBottomPx({
        viewportHeight: 400,
        ceilingPx: 150,
        floorTopsPx: [],
        restTopPx: 380,
        toastHeightPx: 62,
        gapPx: 8,
        keepClearPx: [
          { top: 0, bottom: 300 },
          { top: 380, bottom: 400 },
        ],
        protectPx: [{ top: 300, bottom: 380 }],
      }),
    ).toBe(400 - (300 - 8));
  });

  it("keeps the resting spot when no side of the field has room", () => {
    expect(
      toastDockBottomPx({
        ...landscape,
        protectPx: [{ top: 10, bottom: 380 }],
      }),
    ).toBe(390 - 362 + 8);
  });
});

describe("useToastDock", () => {
  const boxes: Element[] = [];
  afterEach(() => {
    for (const el of boxes.splice(0)) el.remove();
    delete document.documentElement.dataset.shell;
    rememberPressedControl(null);
    vi.restoreAllMocks();
  });

  function box(
    className: string,
    top: number,
    bottom: number,
    left = 0,
    right = 390,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = className;
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom,
        left,
        right,
        width: right - left,
        height: bottom - top,
      }) as DOMRect;
    document.body.append(el);
    boxes.push(el);
    return el;
  }

  it("docks above the crossfade rail, which a join's popover leaves over the lanes", () => {
    document.documentElement.dataset.shell = "phone";
    const shell = box("daw-shell--phone", 0, 844);
    const region = document.createElement("div");
    const card = document.createElement("div");
    card.getBoundingClientRect = () => new DOMRect(40, 0, 310, 62);
    region.append(card);
    document.body.append(region);
    boxes.push(region);
    box("mobile-nav", 792, 844);
    const toolRail = box("editing-tool-rail", 732, 792);
    shell.append(toolRail);
    box("join-edit-rail", 655, 725);
    box("daw-shell-transport", 0, 52);
    shell.append(...document.querySelectorAll(".daw-shell-transport"));
    const { unmount } = renderHook(() =>
      useToastDock({ current: region }, true),
    );
    const bottom = Number.parseFloat(
      region.style.getPropertyValue("--toast-dock-bottom"),
    );
    unmount();
    expect(bottom * 16).toBe(window.innerHeight - 655 + 8);
  });

  it("moves above Listen's Play row when the dock spot would cover it", () => {
    document.documentElement.dataset.shell = "phone";
    const region = document.createElement("div");
    const card = document.createElement("div");
    card.getBoundingClientRect = () => new DOMRect(40, 0, 310, 62);
    region.append(card);
    document.body.append(region);
    boxes.push(region);
    box("mobile-nav", window.innerHeight - 52, window.innerHeight);
    box("mobile-dock", window.innerHeight - 165, window.innerHeight - 52);
    box(
      "listen-hero-controls",
      window.innerHeight - 255,
      window.innerHeight - 199,
    );
    const { unmount } = renderHook(() =>
      useToastDock({ current: region }, true),
    );
    const bottom = Number.parseFloat(
      region.style.getPropertyValue("--toast-dock-bottom"),
    );
    unmount();
    expect(bottom * 16).toBe(255 + 8);
  });

  it("docks above Listen's comment field so a posted comment's toast leaves the field free", () => {
    document.documentElement.dataset.shell = "phone";
    const region = document.createElement("div");
    const card = document.createElement("div");
    card.getBoundingClientRect = () => new DOMRect(40, 0, 310, 62);
    region.append(card);
    document.body.append(region);
    boxes.push(region);
    box("mobile-nav", 792, 844);
    box("mobile-dock", 690, 792);
    const { unmount } = renderHook(() =>
      useToastDock({ current: region }, true),
    );
    const bottom = Number.parseFloat(
      region.style.getPropertyValue("--toast-dock-bottom"),
    );
    unmount();
    expect(bottom * 16).toBe(window.innerHeight - 690 + 8);
  });

  function mountRegion() {
    const region = document.createElement("div");
    const card = document.createElement("div");
    card.getBoundingClientRect = () => new DOMRect(40, 0, 310, 62);
    region.append(card);
    document.body.append(region);
    boxes.push(region);
    const readBottom = () => {
      const { unmount } = renderHook(() =>
        useToastDock({ current: region }, true),
      );
      const bottom = Number.parseFloat(
        region.style.getPropertyValue("--toast-dock-bottom"),
      );
      unmount();
      return bottom * 16;
    };
    return { readBottom, region, card };
  }

  it("moves above a comment field the resting spot would cover on a tablet (#2199)", () => {
    document.documentElement.dataset.shell = "tablet";
    const H = window.innerHeight;
    const { readBottom } = mountRegion();
    box("status-bar", H - 28, H);
    box("comment-compose", H - 84, H - 36);
    expect(readBottom()).toBe(H - (H - 84) + 8);
  });

  it("ignores a comment field scrolled out of its panel (#2199)", () => {
    document.documentElement.dataset.shell = "tablet";
    const H = window.innerHeight;
    const { readBottom } = mountRegion();
    box("status-bar", H - 28, H);
    const panel = box("panel", H - 200, H - 100);
    panel.style.overflowY = "auto";
    panel.append(box("comment-compose", H - 60, H - 10));
    expect(readBottom()).toBe(28 + 8);
  });

  it.each([
    ["disjoint", 1177, 1424, 36],
    ["overlapping", 600, 847, 900 - 588.78125 + 8],
    ["partially overlapping", 862, 1109, 900 - 588.78125 + 8],
    ["touching the right edge", 862.5, 1109.5, 36],
    ["touching the left edge", 330.5, 577.5, 36],
  ])(
    "keeps only %s side composers in the card's path",
    (_name, left, right, expected) => {
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
      document.documentElement.dataset.shell = "desktop";
      const { readBottom, card, region } = mountRegion();
      card.getBoundingClientRect = () => new DOMRect(577.5, 537, 285, 43.59375);
      region.getBoundingClientRect = () => new DOMRect(16, 537, 1408, 43.59375);
      box("status-bar", 872, 900, 0, 1440);
      const inspector = box("inspector", 57, 871, 0, 1440);
      inspector.style.overflowY = "auto";
      inspector.append(
        box("comment-compose", 588.78125, 901.78125, left, right),
      );
      expect(readBottom()).toBe(expected);
    },
  );

  it.each([
    "comment-compose",
    "comment-author-line",
    "comment-author-edit",
    "comment-name-step",
  ])("ignores a disjoint protected %s", (className) => {
    const H = window.innerHeight;
    const { readBottom } = mountRegion();
    box("status-bar", H - 28, H);
    box(className, H - 84, H - 36, 360, 390);
    expect(readBottom()).toBe(36);
  });

  it.each(["pressed", "play"])(
    "projects the %s control against the card",
    (kind) => {
      document.documentElement.dataset.shell = "phone";
      const H = window.innerHeight;
      const { readBottom } = mountRegion();
      box("mobile-nav", H - 52, H);
      const control = box(
        kind === "play" ? "listen-hero-controls" : "",
        H - 110,
        H - 60,
        360,
        390,
      );
      if (kind === "pressed") {
        control.tabIndex = 0;
        rememberPressedControl(control);
      }
      expect(readBottom()).toBe(60);
      control.getBoundingClientRect = () => new DOMRect(340, H - 110, 50, 50);
      expect(readBottom()).toBe(118);
    },
  );

  it.each([
    ["horizontal", "hidden", "visible", 360, 390, 0, 768, 36],
    ["empty horizontal", "hidden", "visible", 380, 390, 0, 768, 36],
    ["empty vertical", "visible", "auto", 0, 390, 732, 768, 36],
    ["vertical", "visible", "auto", 0, 390, 0, 600, 36],
    ["partly horizontal", "auto", "visible", 340, 390, 0, 768, 92],
    ["partly vertical", "visible", "hidden", 0, 390, 700, 768, 76],
    ["both axes", "hidden", "auto", 340, 390, 700, 768, 76],
  ])(
    "clips protected fields on %s ancestors",
    (_name, overflowX, overflowY, left, right, top, bottom, expected) => {
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
      const { readBottom } = mountRegion();
      box("status-bar", 740, 768);
      const panel = box("panel", top, bottom, left, right);
      panel.style.overflowX = overflowX;
      panel.style.overflowY = overflowY;
      panel.append(box("comment-compose", 684, 732, 300, 380));
      expect(readBottom()).toBe(expected);
    },
  );

  it.each([
    [0, 48],
    [80, 0],
  ])(
    "ignores a protected field with width %s and height %s",
    (width, height) => {
      const H = window.innerHeight;
      const { readBottom } = mountRegion();
      box("status-bar", H - 28, H);
      box("comment-compose", H - 84, H - 84 + height, 40, 40 + width);
      expect(readBottom()).toBe(36);
    },
  );

  it("remeasures card width on the next frame without using its current vertical position", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const H = window.innerHeight;
    const { region, card } = mountRegion();
    box("status-bar", H - 28, H);
    box("comment-compose", H - 84, H - 36, 360, 390);
    const { unmount } = renderHook(() =>
      useToastDock({ current: region }, true),
    );
    const bottom = () =>
      Number.parseFloat(region.style.getPropertyValue("--toast-dock-bottom")) *
      16;
    expect(bottom()).toBe(36);
    card.getBoundingClientRect = () => new DOMRect(40, -500, 340, 62);
    frames.shift()?.(0);
    expect(bottom()).toBe(92);
    card.getBoundingClientRect = () => new DOMRect(40, 2000, 310, 62);
    frames.shift()?.(1);
    expect(bottom()).toBe(36);
    unmount();
  });
});
