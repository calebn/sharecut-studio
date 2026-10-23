import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toastDockBottomPx, usePhoneToastDock } from "./toastDock";

/** 390×844 phone: transport 0–52, mode nav 792–844, toast 62 tall, 12px gap. */
const phone = {
  viewportHeight: 844,
  ceilingPx: 52,
  navTopPx: 792,
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
    navTopPx: 408,
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
        navTopPx: 468,
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

describe("usePhoneToastDock", () => {
  const boxes: Element[] = [];
  afterEach(() => {
    for (const el of boxes.splice(0)) el.remove();
    delete document.documentElement.dataset.shell;
  });

  function box(className: string, top: number, bottom: number): HTMLElement {
    const el = document.createElement("div");
    el.className = className;
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom,
        left: 0,
        right: 390,
        width: 390,
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
    card.getBoundingClientRect = () =>
      ({ top: 0, bottom: 62, height: 62 }) as DOMRect;
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
      usePhoneToastDock({ current: region }, true),
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
    card.getBoundingClientRect = () =>
      ({ top: 0, bottom: 62, height: 62 }) as DOMRect;
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
      usePhoneToastDock({ current: region }, true),
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
    card.getBoundingClientRect = () =>
      ({ top: 0, bottom: 62, height: 62 }) as DOMRect;
    region.append(card);
    document.body.append(region);
    boxes.push(region);
    box("mobile-nav", 792, 844);
    box("mobile-dock", 690, 792);
    const { unmount } = renderHook(() =>
      usePhoneToastDock({ current: region }, true),
    );
    const bottom = Number.parseFloat(
      region.style.getPropertyValue("--toast-dock-bottom"),
    );
    unmount();
    expect(bottom * 16).toBe(window.innerHeight - 690 + 8);
  });
  it("moves above a comment field the resting spot would cover on a tablet (#2199)", () => {
    document.documentElement.dataset.shell = "tablet";
    const H = window.innerHeight;
    const region = document.createElement("div");
    const card = document.createElement("div");
    card.getBoundingClientRect = () =>
      ({ top: 0, bottom: 62, height: 62 }) as DOMRect;
    region.append(card);
    document.body.append(region);
    boxes.push(region);
    box("status-bar", H - 28, H);
    box("comment-compose", H - 84, H - 36);
    const { unmount } = renderHook(() =>
      usePhoneToastDock({ current: region }, true),
    );
    const bottom = Number.parseFloat(
      region.style.getPropertyValue("--toast-dock-bottom"),
    );
    unmount();
    expect(bottom * 16).toBe(H - (H - 84) + 8);
  });
});
