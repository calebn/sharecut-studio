import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import { BottomSheet } from "../../ui/BottomSheet";
import { readCompactInspectorView } from "../../utils/compactInspectorPref";
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
    const { result } = renderHook(() => useCompactInspector(true, true));
    expect(result.current?.peek.title).toBe("Trim start");
    expect(compactSheetProps(result.current!)).toMatchObject({
      title: "Trim start",
      drawer: {
        detents: ["peek", "half", "full"],
        detent: "peek",
        label: "Inspector height",
      },
      stowed: false,
      className: "bottom-sheet--inspector bottom-sheet--compact",
    });
    const sheet = render(<CompactSheet />);
    expect(screen.getByRole("group", { name: "Undo and redo" })).toBeVisible();
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(redo);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing to redo");
    sheet.unmount();
  });

  it("does not expose history actions to a share without edit authority", () => {
    act(() =>
      useDawStore.setState({
        projectPath: "share:viewer",
        guestMode: "view",
        shareCapabilities: ["view"],
      }),
    );
    const sheet = render(<CompactSheet />);
    expect(screen.queryByRole("group", { name: "Undo and redo" })).toBeNull();
    sheet.unmount();
  });

  it("is off when the phone shows the Script and on a tablet or the desktop", () => {
    expect(
      renderHook(() => useCompactInspector(true, false)).result.current,
    ).toBe(null);
    expect(
      renderHook(() => useCompactInspector(false, true)).result.current,
    ).toBe(null);
  });

  it("leaves a selection the open plain sheet's own form made in that sheet until it closes", () => {
    act(() =>
      useDawStore.setState({
        selection: { kind: "track", trackId: "host" },
        selectionHit: null,
      }),
    );
    const { result } = renderHook(() => useCompactInspector(true, true));
    expect(result.current).toBeNull();
    act(() =>
      useDawStore
        .getState()
        .selectFromInspector({ kind: "clip", id: "c2", trackId: "host" }),
    );
    expect(result.current).toBeNull();

    act(() => useDawStore.setState({ selection: null }));
    act(() =>
      useDawStore.setState({
        selection: { kind: "clip", id: "c2", trackId: "host" },
      }),
    );
    expect(result.current?.peek.title).toBe("host clip");
    expect(result.current?.view).toBe("peek");
  });

  it("opens the strip for a timeline tap while a plain sheet is open, and ends a form's hold", () => {
    act(() =>
      useDawStore.setState({
        selection: { kind: "track", trackId: "host" },
        selectionHit: null,
      }),
    );
    const { result } = renderHook(() => useCompactInspector(true, true));
    expect(result.current).toBeNull();
    act(() => useDawStore.getState().selectClip("c2", "host"));
    expect(result.current?.peek.title).toBe("host clip");

    act(() => useDawStore.setState({ selection: null }));
    act(() =>
      useDawStore.setState({ selection: { kind: "track", trackId: "host" } }),
    );
    act(() =>
      useDawStore
        .getState()
        .selectFromInspector({ kind: "clip", id: "c2", trackId: "host" }),
    );
    expect(result.current).toBeNull();
    act(() => useDawStore.getState().selectClip("c2", "host"));
    expect(result.current?.peek.title).toBe("host clip");
  });

  it("remembers the drawer's detent for the next selection, and stows during a drag", () => {
    const { result } = renderHook(() => useCompactInspector(true, true));
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
  const compact = useCompactInspector(true, true);
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
      <div class="bottom-sheet-root"><div class="bottom-sheet bottom-sheet--inspector bottom-sheet--compact"></div></div>`;
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
      <div class="timeline-scroll"><div class="marker-lane" style="position: sticky"></div>
        <button data-clip-id="c2"></button></div>
      <div class="bottom-sheet-root"><div class="bottom-sheet bottom-sheet--inspector bottom-sheet--compact"></div></div>`;
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

  it("lets a target rise to the ruler once the marker rows stop pinning", () => {
    document.body.innerHTML = `
      <div class="timeline-scroll"><div class="time-ruler"></div>
        <div class="marker-lane" style="position: relative"></div>
        <button data-clip-id="c2"></button></div>
      <div class="bottom-sheet-root"><div class="bottom-sheet bottom-sheet--inspector bottom-sheet--compact"></div></div>`;
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    place(scroller, 52, 700);
    place(document.querySelector(".time-ruler")!, 52, 76);
    place(document.querySelector(".marker-lane")!, 76, 148);
    place(document.querySelector("[data-clip-id]")!, 110, 650);
    place(document.querySelector(".bottom-sheet-root")!, 0, 748);
    Object.defineProperty(
      document.querySelector(".bottom-sheet"),
      "offsetHeight",
      { value: 400 },
    );
    keepTargetClear('[data-clip-id="c2"]');
    expect(scroller.scrollTop).toBe(34);
  });
});
