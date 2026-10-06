import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { stubMatchMedia } from "../test/matchMedia";
import { setLabEnabled } from "../utils/labFlags";
import {
  compactSheetProps,
  keepTargetClear,
  useCompactInspector,
} from "./useCompactInspector";

const clip = clipRow({ id: "c2", track_id: "host", timeline_start: 10 });

function place(el: Element, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 360, height: bottom - top }) as DOMRect;
}

beforeEach(() => {
  stubMatchMedia(false);
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: [clip] }, clip_count: 1 },
    }),
    null,
  );
  useDawStore.setState({
    mobileMode: "timeline",
    selection: { kind: "clip", id: "c2", trackId: "host" },
    selectionHit: { kind: "trim-in", id: "c2" },
    compactInspectorView: "strip",
    timelineDragging: false,
  });
  setLabEnabled("touchChooser", true);
});

afterEach(() => {
  setLabEnabled("touchChooser", false);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useCompactInspector", () => {
  it("opens the strip on a phone's timeline selection, behind the lab", () => {
    const { result, rerender } = renderHook(() => useCompactInspector("phone"));
    expect(result.current?.peek.title).toBe("Trim start");
    expect(compactSheetProps(result.current!)).toMatchObject({
      title: "Trim start",
      size: "peek",
      expandedSize: "half",
      expanded: false,
      stowed: false,
      className: "bottom-sheet--compact",
    });
    act(() => setLabEnabled("touchChooser", false));
    rerender();
    expect(result.current).toBeNull();
  });

  it("is off in other phone modes and on tablets unless the screen is short", () => {
    act(() => useDawStore.setState({ mobileMode: "text" }));
    expect(renderHook(() => useCompactInspector("phone")).result.current).toBe(
      null,
    );
    const media = stubMatchMedia(false);
    const tablet = renderHook(() => useCompactInspector("tablet"));
    expect(tablet.result.current).toBeNull();
    act(() => media.setMatches(true));
    expect(tablet.result.current?.peek.title).toBe("Trim start");
    expect(renderHook(() => useCompactInspector(null)).result.current).toBe(
      null,
    );
  });

  it("remembers Expand and Collapse for the next selection, and stows during a drag", () => {
    const { result } = renderHook(() => useCompactInspector("phone"));
    act(() => compactSheetProps(result.current!).onExpandedChange?.(true));
    expect(localStorage.getItem("sharecut.compactInspector")).toBe("inspector");
    act(() =>
      useDawStore.setState({
        selection: { kind: "clip", id: "c2", trackId: "host" },
        selectionHit: null,
      }),
    );
    expect(compactSheetProps(result.current!)).toMatchObject({
      title: "Inspector",
      expanded: true,
    });
    act(() => useDawStore.setState({ timelineDragging: true }));
    expect(compactSheetProps(result.current!).stowed).toBe(true);
    act(() => compactSheetProps(result.current!).onExpandedChange?.(false));
    expect(localStorage.getItem("sharecut.compactInspector")).toBe("strip");
  });
});

describe("keepTargetClear", () => {
  it("pads the scroller as deep as the sheet covers it and scrolls the target above it", () => {
    document.body.innerHTML = `
      <div class="timeline-scroll"><div class="marker-lane"></div>
        <button data-clip-id="c2"></button></div>
      <div class="bottom-sheet-root"><div class="bottom-sheet bottom-sheet--compact"></div></div>`;
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    place(scroller, 52, 700);
    place(document.querySelector(".marker-lane")!, 52, 96);
    place(document.querySelector("[data-clip-id]")!, 600, 650);
    place(document.querySelector(".bottom-sheet-root")!, 0, 748);
    Object.defineProperty(
      document.querySelector(".bottom-sheet"),
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
      <div class="timeline-scroll"><div class="marker-lane"></div>
        <button data-clip-id="c2"></button></div>
      <div class="bottom-sheet-root"><div class="bottom-sheet bottom-sheet--compact"></div></div>`;
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    place(scroller, 52, 700);
    place(document.querySelector(".marker-lane")!, 52, 96);
    place(document.querySelector("[data-clip-id]")!, 110, 650);
    place(document.querySelector(".bottom-sheet-root")!, 0, 748);
    Object.defineProperty(
      document.querySelector(".bottom-sheet"),
      "offsetHeight",
      { value: 400 },
    );
    keepTargetClear('[data-clip-id="c2"]');
    expect(scroller.scrollTop).toBe(14);
  });
});
