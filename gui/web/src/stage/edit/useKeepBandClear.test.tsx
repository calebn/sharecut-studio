import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { bandLocator, useKeepBandClear } from "./useKeepBandClear";

function place(el: Element, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 360, height: bottom - top }) as DOMRect;
}

/** An upright phone: the sheet rests at 748 - 360 = 388, under the band at 500. */
function mountPage() {
  document.body.innerHTML = `
    <div class="timeline-scroll"><div class="marker-lane" style="position: sticky"></div>
      <div data-hit-kind="bleed-attenuation" data-hit-id="late_gate:0"></div></div>
    <div class="bottom-sheet-root"><div class="bottom-sheet bottom-sheet--inspector"></div></div>`;
  const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
  place(scroller, 52, 700);
  place(document.querySelector(".marker-lane")!, 52, 96);
  place(document.querySelector("[data-hit-kind]")!, 500, 530);
  place(document.querySelector(".bottom-sheet-root")!, 0, 748);
  Object.defineProperty(
    document.querySelector(".bottom-sheet"),
    "offsetHeight",
    { value: 360 },
  );
  return scroller;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("bandLocator", () => {
  it("names the picked band, or its clip before one is picked, and nothing for other kinds", () => {
    expect(
      bandLocator({
        kind: "bleedAttenuation",
        id: "c2",
        trackId: "host",
        regionKey: "late_gate:0",
      }),
    ).toBe('[data-hit-kind="bleed-attenuation"][data-hit-id="late_gate:0"]');
    expect(
      bandLocator({
        kind: "bleedAttenuation",
        id: "c2",
        trackId: "host",
        regionKey: null,
      }),
    ).toBe('[data-clip-id="c2"]');
    expect(bandLocator({ kind: "clip", id: "c2", trackId: "host" })).toBeNull();
    expect(bandLocator(null)).toBeNull();
  });
});

describe("useKeepBandClear", () => {
  it("scrolls a band the sheet covers above it and pads the scroller as deep as the sheet", () => {
    const scroller = mountPage();
    renderHook(() =>
      useKeepBandClear(
        '[data-hit-kind="bleed-attenuation"][data-hit-id="late_gate:0"]',
      ),
    );
    // Sheet top 388; the band must end 8 px above it: 530 - 380 = 150.
    expect(scroller.scrollTop).toBe(150);
    expect(scroller.style.getPropertyValue("--sheet-clearance")).toBe("312px");
  });

  it("leaves the page alone with no band selected, and drops the padding when it ends", () => {
    const scroller = mountPage();
    const idle = renderHook(() => useKeepBandClear(null));
    expect(scroller.scrollTop).toBe(0);
    idle.unmount();
    const active = renderHook(() =>
      useKeepBandClear(
        '[data-hit-kind="bleed-attenuation"][data-hit-id="late_gate:0"]',
      ),
    );
    active.unmount();
    expect(scroller.style.getPropertyValue("--sheet-clearance")).toBe("");
  });
});
