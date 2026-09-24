import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { FIT_GUTTER, MARKER_ROW_HEIGHT, RULER_HEIGHT } from "../utils/layout";
import { TimelineView } from "./TimelineView";

describe("TimelineView follow auto-fit", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 800;
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("exposes the labeled loading timeline as a group", async () => {
    useDawStore.setState({ project: null });
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <TimelineView />
      </DawProvider>,
    );

    const timeline = screen.getByRole("group", { name: "Loading timeline" });
    expect(timeline).toHaveAttribute("aria-busy", "true");
    await expectNoA11yViolations(container);
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  it("does not auto-fit or unfollow when a desktop timeline mounts while following", () => {
    const fitToWindow = vi.fn();
    const stopFollow = vi.fn();
    useDawStore.setState({
      followingClientId: "leader",
      userZoomed: false,
      fitToWindow,
      stopFollow,
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView />
      </DawProvider>,
    );
    expect(fitToWindow).not.toHaveBeenCalled();
    expect(stopFollow).not.toHaveBeenCalled();
    expect(useDawStore.getState().followingClientId).toBe("leader");
  });

  it("sets ruler and marker-row px vars from the layout constants", () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView />
      </DawProvider>,
    );
    const area = container.querySelector(".timeline-area") as HTMLElement;
    expect(area.style.getPropertyValue("--ruler-height")).toBe(
      `${RULER_HEIGHT}px`,
    );
    expect(area.style.getPropertyValue("--marker-row-height")).toBe(
      `${MARKER_ROW_HEIGHT}px`,
    );
    // Empty project: one quiet marker row.
    expect(area.style.getPropertyValue("--marker-lane-height")).toBe(
      `${MARKER_ROW_HEIGHT}px`,
    );
  });

  it("does not unfollow when store scroll is written to the DOM", () => {
    const stopFollow = vi.fn();
    useDawStore.setState({
      followingClientId: "leader",
      stopFollow,
      scrollLeft: 0,
    });
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView />
      </DawProvider>,
    );
    const scroller = container.querySelector(".timeline-scroll");
    expect(scroller).toBeTruthy();
    let left = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => left,
      set(v: number) {
        left = v;
        scroller?.dispatchEvent(new Event("scroll"));
      },
    });
    act(() => {
      useDawStore.getState().setScrollLeft(160);
    });
    expect(stopFollow).not.toHaveBeenCalled();
    expect(useDawStore.getState().followingClientId).toBe("leader");
  });
});

/** ResizeObserver that records what it watches and fires on demand. */
class RecordingResizeObserver {
  static all: RecordingResizeObserver[] = [];
  targets: Element[] = [];
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    RecordingResizeObserver.all.push(this);
  }
  observe(el: Element): void {
    this.targets.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.targets = [];
  }
  fire(width: number, height: number): void {
    this.cb(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

function twoTrackProject() {
  const track = (id: string) => ({
    id,
    label: id,
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 60,
    fx_count: 0,
    stem_is_fresh: true,
  });
  return minimalProject({
    tracks: [track("host"), track("guest")],
    clips: { tracks: { host: [], guest: [] }, clip_count: 0 },
  });
}

describe("TimelineView lane fit", () => {
  // Stage chrome under the lanes: ruler + one quiet marker row + gutter.
  const chrome = RULER_HEIGHT + MARKER_ROW_HEIGHT + FIT_GUTTER;

  beforeEach(() => {
    RecordingResizeObserver.all = [];
    vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
    for (const [prop, value] of [
      ["clientWidth", 800],
      ["clientHeight", chrome + 2 * 150],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => value,
      });
    }
    useDawStore.getState().hydrate("/tmp/p.json", twoTrackProject());
    useDawStore.setState({ userZoomed: true, followingClientId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  const laneHeightVar = (container: HTMLElement) =>
    (
      container.querySelector(".timeline-area") as HTMLElement
    ).style.getPropertyValue("--lane-height");

  it("fits lanes to the measured stage with one scroller observer", () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={twoTrackProject()}>
        <TimelineView />
      </DawProvider>,
    );
    expect(laneHeightVar(container)).toBe("150px");
    const scroller = container.querySelector(".timeline-scroll");
    const watching = RecordingResizeObserver.all.filter((ro) =>
      ro.targets.includes(scroller as Element),
    );
    expect(watching).toHaveLength(1);
  });

  it("re-renders on a vertical resize only when the lane height changes", () => {
    const onRender = vi.fn();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={twoTrackProject()}>
        <Profiler id="timeline" onRender={onRender}>
          <TimelineView />
        </Profiler>
      </DawProvider>,
    );
    const scroller = container.querySelector(".timeline-scroll") as Element;
    const ro = RecordingResizeObserver.all.find((o) =>
      o.targets.includes(scroller),
    ) as RecordingResizeObserver;
    onRender.mockClear();

    // A pixel of splitter drag: same whole-px lane height, no re-render.
    act(() => ro.fire(800, chrome + 2 * 150 + 1));
    expect(onRender).not.toHaveBeenCalled();

    act(() => ro.fire(800, chrome + 2 * 180));
    expect(onRender).toHaveBeenCalled();
    expect(laneHeightVar(container)).toBe("180px");
  });
});
