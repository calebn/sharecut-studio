import { act, render, renderHook } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import { minimalProject, recordSnapshot } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import {
  FixedPlayheadRecenter,
  TimelineScrollSync,
  useFixedPlayheadScroll,
} from "./useFixedPlayheadScroll";

describe("useFixedPlayheadScroll", () => {
  let raf: ReturnType<typeof stubRaf>;
  let el: HTMLDivElement;
  let input: Parameters<typeof useFixedPlayheadScroll>[0];

  beforeEach(() => {
    raf = stubRaf();
    el = document.createElement("div");
    document.body.append(el);
    useDawStore.getState().hydrate("/tmp/scroll-hook.json", minimalProject());
    useDawStore.setState({
      zoomPxPerSec: 10,
      userZoomed: true,
      followingClientId: null,
      playheadSec: 0,
      scrollLeft: 0,
    });
    input = {
      scrollRef: { current: el },
      fixedPlayhead: true,
      timeViewportPx: 400,
      sessionSec: 60,
      zoomPxPerSec: 10,
      followingClientId: null,
    };
  });

  afterEach(() => {
    raf.fire(0);
    useRecordHostStore.getState().setSnapshot(null);
    el.remove();
    timelineViewportRegistry.clear();
    vi.unstubAllGlobals();
  });

  it("uses committed fixed canvas and clears the lead and negative scroll on unmount", () => {
    const hook = renderHook(() => useFixedPlayheadScroll(input));
    expect(hook.result.current.leadPx).toBe(200);
    expect(hook.result.current.canvas).toEqual({
      widthPx: 600,
      durationSec: 60,
    });
    expect(timelineViewportRegistry.getLeadPx()).toBe(200);
    act(() => useDawStore.getState().setScrollLeft(-150));
    hook.unmount();
    expect(timelineViewportRegistry.getLeadPx()).toBe(0);
    expect(useDawStore.getState().scrollLeft).toBe(0);
  });

  it("uses the desktop minimum canvas and clamps a scroll when its lead disappears", () => {
    const hook = renderHook((props) => useFixedPlayheadScroll(props), {
      initialProps: input,
    });
    act(() => useDawStore.getState().setScrollLeft(-150));
    hook.rerender({ ...input, fixedPlayhead: false, sessionSec: 10 });
    expect(hook.result.current.leadPx).toBe(0);
    expect(hook.result.current.canvas).toEqual({
      widthPx: 400,
      durationSec: 40,
    });
    expect(useDawStore.getState().scrollLeft).toBe(0);
  });

  it("keeps the writer stable and the render binding immutable across geometry changes", () => {
    const hook = renderHook((props) => useFixedPlayheadScroll(props), {
      initialProps: input,
    });
    const first = hook.result.current;
    hook.rerender({ ...input, timeViewportPx: 500 });
    expect(hook.result.current.writeScroll).toBe(first.writeScroll);
    expect(hook.result.current.binding).not.toBe(first.binding);
    expect(first.binding.leadPx).toBe(200);
    expect(first.binding.timeViewportPx).toBe(400);
    expect(hook.result.current.binding.leadPx).toBe(250);
  });

  it("classifies delayed browser-clamped echoes and genuine DOM scrolls with the real store", () => {
    const hook = renderHook(() =>
      useFixedPlayheadScroll({ ...input, followingClientId: "leader" }),
    );
    let left = 0;
    Object.defineProperty(el, "scrollLeft", {
      get: () => left,
      set: (value: number) => {
        left = Math.min(300, value);
      },
    });
    el.addEventListener("scroll", () => hook.result.current.onScroll());
    act(() => useDawStore.setState({ followingClientId: "leader" }));
    act(() => hook.result.current.writeScroll(el, 500, 200));
    expect(el.scrollLeft).toBe(300);
    act(() => raf.fire(0));
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().followingClientId).toBe("leader");
    expect(useDawStore.getState().playheadSec).toBe(0);
    expect(useDawStore.getState().scrollLeft).toBe(100);
    el.scrollLeft = 250;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().followingClientId).toBeNull();
    expect(useDawStore.getState().playheadSec).toBe(25);
    expect(useDawStore.getState().scrollLeft).toBe(50);
  });

  it("keeps desktop user pans visual and stores their logical scroll", () => {
    const hook = renderHook(() =>
      useFixedPlayheadScroll({ ...input, fixedPlayhead: false }),
    );
    el.addEventListener("scroll", () => hook.result.current.onScroll());
    el.scrollLeft = 300;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().playheadSec).toBe(0);
    expect(useDawStore.getState().scrollLeft).toBe(300);
  });

  it("gates pointer zoom scroll until the animation frame releases it", () => {
    timelineViewportRegistry.setTimelineElement(el);
    Object.defineProperty(el, "clientWidth", { value: 400 });
    const hook = renderHook(() => useFixedPlayheadScroll(input));
    el.addEventListener("scroll", () => hook.result.current.onScroll());
    act(() => hook.result.current.applyZoomAt(20, 300));
    expect(useDawStore.getState().zoomPxPerSec).toBe(20);
    el.scrollLeft = 100;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().playheadSec).toBe(0);
    expect(useDawStore.getState().scrollLeft).toBe(-100);
    act(() => raf.fire(0));
    el.scrollLeft = 150;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().playheadSec).toBe(15);
    timelineViewportRegistry.setTimelineElement(null);
  });

  it("does not subscribe the parent hook to transport, scroll, seek intent or recording", () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders++;
      return useFixedPlayheadScroll(input);
    });
    const before = renders;
    act(() => useDawStore.getState().setPlayheadSec(15, "playback"));
    act(() => useDawStore.getState().setScrollLeft(100));
    act(() => useDawStore.getState().setPlayheadSec(15));
    act(() => useRecordHostStore.getState().setSnapshot(recordSnapshot()));
    expect(renders).toBe(before);
    expect(hook.result.current.binding.leadPx).toBe(200);
  });

  it("writes committed canvas geometry in the child before parent lead registration", () => {
    const writes: { dom: number; width: string; registryLead: number }[] = [];
    const parents: number[] = [];
    function Harness({
      viewport,
      zoom = 10,
    }: {
      viewport: number;
      zoom?: number;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      const scroll = useFixedPlayheadScroll({
        ...input,
        scrollRef: ref,
        timeViewportPx: viewport,
        zoomPxPerSec: zoom,
      });
      useLayoutEffect(() => {
        parents.push(timelineViewportRegistry.getLeadPx());
      });
      return (
        <div ref={ref} style={{ width: scroll.canvas.widthPx }}>
          <TimelineScrollSync binding={scroll.binding} />
        </div>
      );
    }
    const view = render(<Harness viewport={400} />);
    const scroller = view.container.firstChild as HTMLDivElement;
    let left = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      get: () => left,
      set: (value: number) => {
        left = value;
        writes.push({
          dom: value,
          width: scroller.style.width,
          registryLead: timelineViewportRegistry.getLeadPx(),
        });
      },
    });
    act(() => useDawStore.getState().setScrollLeft(100));
    writes.length = 0;
    act(() => {
      useDawStore.setState({ zoomPxPerSec: 20 });
      view.rerender(<Harness viewport={500} zoom={20} />);
    });
    expect(writes).toEqual([{ dom: 350, width: "1200px", registryLead: 200 }]);
    expect(parents.at(-1)).toBe(250);
  });

  it("keeps a paused beyond-media pan until an explicit same-position seek", () => {
    const hook = renderHook(() => useFixedPlayheadScroll(input));
    useRecordHostStore
      .getState()
      .setSnapshot(recordSnapshot({ state: "paused" }));
    const leaf = render(
      <FixedPlayheadRecenter binding={hook.result.current.binding} />,
    );
    act(() => raf.fire(0));
    el.scrollLeft = 1000;
    act(() => hook.result.current.onScroll());
    expect(useDawStore.getState().scrollLeft).toBe(800);
    expect(useDawStore.getState().playheadSec).toBe(0);
    leaf.rerender(
      <FixedPlayheadRecenter binding={hook.result.current.binding} />,
    );
    expect(el.scrollLeft).toBe(1000);
    act(() => useDawStore.getState().setPlayheadSec(0));
    expect(el.scrollLeft).toBe(0);
    expect(useDawStore.getState().scrollLeft).toBe(-200);
  });
});
