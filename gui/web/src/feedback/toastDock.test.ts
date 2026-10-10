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
  it.each([
    {
      action: "Time +0.01",
      pressedPx: { top: 434, bottom: 522 },
      otherControl: { top: 199, bottom: 287 },
    },
    {
      action: "Level +0.01",
      pressedPx: { top: 628, bottom: 716 },
      otherControl: { top: 434, bottom: 522 },
    },
  ])(
    "keeps another visible compact control clear after $action",
    ({ pressedPx, otherControl }) => {
      const bottom = toastDockBottomPx({
        viewportHeight: 844,
        ceilingPx: 104,
        floorTopsPx: [740, 28],
        navTopPx: 740,
        toastHeightPx: 222,
        gapPx: 16,
        pressedPx,
      });
      expect(Number.isFinite(bottom)).toBe(true);
      const toastBottom = 844 - bottom;
      const toastTop = toastBottom - 222;
      expect(
        toastTop < otherControl.bottom && toastBottom > otherControl.top,
      ).toBe(false);
    },
  );

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
});
