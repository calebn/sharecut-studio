import { afterEach, describe, expect, it } from "vitest";
import { keepTargetClear } from "./keepTargetClear";

function place(el: Element, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 360, height: bottom - top }) as DOMRect;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("keepTargetClear", () => {
  it("pads the scroller as deep as the sheet covers it and scrolls the target above it", () => {
    document.body.innerHTML = `
      <div class="timeline-scroll"><div class="marker-lane"></div>
        <button data-clip-id="c2"></button></div>
      <div class="bottom-sheet-root"><div class="sys-inspector--phone"></div></div>`;
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    place(scroller, 52, 700);
    place(document.querySelector(".marker-lane")!, 52, 96);
    place(document.querySelector("[data-clip-id]")!, 600, 650);
    place(document.querySelector(".bottom-sheet-root")!, 0, 748);
    Object.defineProperty(
      document.querySelector(".sys-inspector--phone"),
      "offsetHeight",
      { value: 120 },
    );
    keepTargetClear('[data-clip-id="c2"]');
    // Sheet rests at 748 - 120 = 628; the target must end 8 px above it.
    expect(scroller.style.getPropertyValue("--sheet-clearance")).toBe("72px");
    expect(scroller.scrollTop).toBe(30);
  });

  it("never scrolls a target up under the ruler and marker lane", () => {
    document.body.innerHTML = `
      <div class="timeline-scroll"><div class="marker-lane" style="position: sticky"></div>
        <button data-clip-id="c2"></button></div>
      <div class="bottom-sheet-root"><div class="sys-inspector--phone"></div></div>`;
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    place(scroller, 52, 700);
    place(document.querySelector(".marker-lane")!, 52, 96);
    place(document.querySelector("[data-clip-id]")!, 110, 650);
    place(document.querySelector(".bottom-sheet-root")!, 0, 748);
    Object.defineProperty(
      document.querySelector(".sys-inspector--phone"),
      "offsetHeight",
      { value: 400 },
    );
    keepTargetClear('[data-clip-id="c2"]');
    expect(scroller.scrollTop).toBe(14);
  });

  it("lets a target rise to the ruler once the marker rows stop pinning", () => {
    document.body.innerHTML = `
      <div class="timeline-scroll"><div class="timeline-ruler"></div>
        <div class="marker-lane" style="position: relative"></div>
        <button data-clip-id="c2"></button></div>
      <div class="bottom-sheet-root"><div class="sys-inspector--phone"></div></div>`;
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    place(scroller, 52, 700);
    place(document.querySelector(".timeline-ruler")!, 52, 76);
    place(document.querySelector(".marker-lane")!, 76, 148);
    place(document.querySelector("[data-clip-id]")!, 110, 650);
    place(document.querySelector(".bottom-sheet-root")!, 0, 748);
    Object.defineProperty(
      document.querySelector(".sys-inspector--phone"),
      "offsetHeight",
      { value: 400 },
    );
    keepTargetClear('[data-clip-id="c2"]');
    expect(scroller.scrollTop).toBe(34);
  });
});
