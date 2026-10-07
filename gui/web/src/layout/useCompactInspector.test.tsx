import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { stubMatchMedia } from "../test/matchMedia";
import { BottomSheet } from "../ui/BottomSheet";
import { readCompactInspectorView } from "../utils/compactInspectorPref";
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
    compactInspectorView: "peek",
    timelineDragging: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useCompactInspector", () => {
  it("opens the strip on a phone's timeline selection", () => {
    const { result } = renderHook(() => useCompactInspector("phone"));
    expect(result.current?.peek.title).toBe("Trim start");
    expect(compactSheetProps(result.current!)).toMatchObject({
      title: "Trim start",
      drawer: {
        detents: ["peek", "half", "full"],
        detent: "peek",
        label: "Inspector height",
      },
      stowed: false,
      className: "bottom-sheet--compact",
    });
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

  it("remembers the drawer's detent for the next selection, and stows during a drag", () => {
    const { result } = renderHook(() => useCompactInspector("phone"));
    act(() =>
      compactSheetProps(result.current!).drawer?.onDetentChange("full"),
    );
    expect(localStorage.getItem("sharecut.compactInspector")).toBe("full");
    act(() =>
      useDawStore.setState({
        selection: { kind: "clip", id: "c2", trackId: "host" },
        selectionHit: null,
      }),
    );
    expect(compactSheetProps(result.current!)).toMatchObject({
      title: "host clip",
      drawer: { detent: "full" },
    });
    act(() => useDawStore.setState({ timelineDragging: true }));
    expect(compactSheetProps(result.current!).stowed).toBe(true);
    act(() =>
      compactSheetProps(result.current!).drawer?.onDetentChange("peek"),
    );
    expect(localStorage.getItem("sharecut.compactInspector")).toBe("peek");
  });
});

function CompactSheet() {
  const compact = useCompactInspector("phone");
  return compact ? (
    <BottomSheet
      open
      onClose={() => undefined}
      backgroundPolicy="interactive"
      {...compactSheetProps(compact)}
    >
      {compact.view}
    </BottomSheet>
  ) : null;
}

describe("the compact drawer's Expand and Collapse", () => {
  const select = (hit: "trim-in" | "fade-in") =>
    act(() =>
      useDawStore.setState({
        selection: { kind: "clip", id: "c2", trackId: "host" },
        selectionHit: { kind: hit, id: "c2" },
      }),
    );
  const size = () =>
    document
      .querySelector(".bottom-sheet")
      ?.className.match(/bottom-sheet--(peek|half|full)/)?.[1];

  it("steps up a detent with Expand, opens the next selection there, and Collapse returns to the strip", () => {
    const { unmount } = render(<CompactSheet />);
    expect(size()).toBe("peek");
    fireEvent.click(
      screen.getByRole("button", { name: "Expand to half height" }),
    );
    select("fade-in");
    expect({ size: size(), pref: readCompactInspectorView() }).toEqual({
      size: "half",
      pref: "half",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Expand to full height" }),
    );
    expect(size()).toBe("full");
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse to strip" }));
    select("trim-in");
    expect({
      size: size(),
      pref: readCompactInspectorView(),
      title: screen.getByRole("heading").textContent,
    }).toEqual({ size: "peek", pref: "peek", title: "Trim start" });
    unmount();
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
