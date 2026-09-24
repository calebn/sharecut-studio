import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleComment } from "../test/fixtures";
import type { ClipRow, ProjectView } from "../types/project";
import {
  COMPACT_LANE_HEIGHT,
  FIT_GUTTER,
  LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  RULER_HEIGHT,
} from "../utils/layout";
import { TimelineView } from "./TimelineView";
import { useTimelineMetrics } from "./timelineMetrics";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../commands/execute", () => ({ execute }));
// Clips here exercise geometry and gestures, not waveform fetching.
vi.mock("../hooks/useClipWaveform", () => ({
  useClipWaveform: () => ({
    window: {
      cssWidth: 0,
      canvasLeft: 0,
      sourceStart: 0,
      sourceEnd: 0,
      offscreen: true,
    },
    quiet: [],
    ticks: [],
    paint: () => undefined,
  }),
}));

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

  it("flags compact lane density when lanes sit at the 72px floor", () => {
    // jsdom measures a 0px stage, so lanes stay at LANE_HEIGHT (72px), below
    // COMPACT_LANE_HEIGHT: headers switch to one row plus the gain strip.
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView />
      </DawProvider>,
    );
    const area = container.querySelector(".timeline-area") as HTMLElement;
    expect(area.style.getPropertyValue("--lane-height")).toBe(
      `${LANE_HEIGHT}px`,
    );
    expect(LANE_HEIGHT).toBeLessThan(COMPACT_LANE_HEIGHT);
    expect(area.dataset.laneDensity).toBe("compact");
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

describe("TimelineView fixed playhead (#385)", () => {
  // Earlier tests stub store actions; these need the real ones.
  const { fitToWindow, stopFollow } = useDawStore.getState();

  // 400px scroller, no header column: lead = 200px, 10px/s, 60 s session.
  beforeEach(() => {
    RecordingResizeObserver.all = [];
    vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
    for (const [prop, value] of [
      ["clientWidth", 400],
      ["clientHeight", 600],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => value,
      });
    }
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      userZoomed: true,
      zoomPxPerSec: 10,
      playheadSec: 0,
      followingClientId: null,
      fitToWindow,
      stopFollow,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  /** Mount with a scroller whose scrollLeft is plain storage (jsdom's isn't). */
  function mountFixed() {
    const view = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView fixedPlayhead />
      </DawProvider>,
    );
    const scroller = view.container.querySelector(
      ".timeline-scroll",
    ) as HTMLElement;
    let left = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => left,
      set(v: number) {
        left = v;
      },
    });
    const userScrollTo = (dom: number) => {
      left = dom;
      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
    };
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    return { ...view, scroller, userScrollTo, settle };
  }

  it("pads the time column by half the viewport and registers the lead", () => {
    const { container } = mountFixed();
    const area = container.querySelector(".timeline-area") as HTMLElement;
    expect(area.style.getPropertyValue("--timeline-lead")).toBe("200px");
    expect(area.style.getPropertyValue("--timeline-fixed-line")).toBe("200px");
  });

  it("seeks on a person's scroll, not on a write or its late echo", async () => {
    const { scroller, userScrollTo, settle } = mountFixed();
    act(() => {
      useDawStore.getState().setPlayheadSec(15);
    });
    // Recentered: 15 s × 10 px/s − 200 px center = −50 logical, 150 DOM.
    expect(scroller.scrollLeft).toBe(150);
    expect(useDawStore.getState().scrollLeft).toBe(-50);

    // The write's scroll event can land after the programmatic flags clear.
    await settle();
    userScrollTo(150);
    expect(useDawStore.getState().playheadSec).toBe(15);

    userScrollTo(250); // 100 px further: 10 s later
    expect(useDawStore.getState().playheadSec).toBeCloseTo(25, 9);

    userScrollTo(250.5); // under a pixel: not a move
    expect(useDawStore.getState().playheadSec).toBeCloseTo(25, 9);
  });

  it("clamps a person's scroll to the session end", async () => {
    const { userScrollTo, settle } = mountFixed();
    await settle();
    userScrollTo(5000);
    expect(useDawStore.getState().playheadSec).toBe(60);
  });

  it("keeps the playhead through a fit", () => {
    const { scroller } = mountFixed();
    act(() => {
      useDawStore.getState().setPlayheadSec(15);
    });
    act(() => {
      useDawStore.getState().fitToWindow(400);
    });
    const s = useDawStore.getState();
    expect(s.userZoomed).toBe(false);
    expect(s.playheadSec).toBe(15);
    expect((scroller.scrollLeft - 200 + 200) / s.zoomPxPerSec).toBeCloseTo(
      15,
      9,
    );
  });

  it("leaves no scroll before 0 or lead behind when unmounted", () => {
    const { unmount } = mountFixed();
    act(() => {
      useDawStore.getState().setPlayheadSec(5);
    });
    expect(useDawStore.getState().scrollLeft).toBe(-150);
    unmount();
    expect(useDawStore.getState().scrollLeft).toBe(0);
    useDawStore.getState().applyAnchoredZoom(20);
    expect(useDawStore.getState().scrollLeft).toBeGreaterThanOrEqual(0);
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
      [
        {
          target: this.targets[0],
          contentRect: { width, height },
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

const hostClip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 2,
  timeline_start: 0,
  timeline_end: 2,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

function twoTrackProject(overrides: Partial<ProjectView> = {}) {
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
    ...overrides,
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

  it("keeps the metrics context stable across playhead ticks", () => {
    const headerRenders = vi.fn();
    function HeaderProbe() {
      headerRenders(useTimelineMetrics());
      return <div className="track-headers" />;
    }
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={twoTrackProject()}>
        <TimelineView headerSlot={<HeaderProbe />} />
      </DawProvider>,
    );
    headerRenders.mockClear();
    act(() => useDawStore.getState().setPlayheadSec(5));
    act(() => useDawStore.getState().setPlayheadSec(6));
    expect(headerRenders).not.toHaveBeenCalled();
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

  describe("during a clip move", () => {
    beforeEach(() => {
      execute.mockClear();
      HTMLElement.prototype.setPointerCapture = vi.fn();
    });

    afterEach(() => {
      // Tests assign an own property; drop it to restore jsdom's.
      Reflect.deleteProperty(document, "elementFromPoint");
    });

    it("holds lanes still and drops on the lane the ghost showed", () => {
      const withClip = twoTrackProject({
        clips: { tracks: { host: [hostClip], guest: [] }, clip_count: 1 },
      });
      useDawStore.getState().hydrate("/tmp/p.json", withClip);
      const { container, getByRole } = render(
        <DawProvider projectPath="/tmp/p.json" initialProject={withClip}>
          <TimelineView />
        </DawProvider>,
      );
      const lane = (id: string) =>
        container.querySelector(`.lane-row[data-track-id="${id}"]`) as Element;
      const hit = getByRole("button", { name: "Select clip c1" });

      document.elementFromPoint = () => lane("guest");
      fireEvent.pointerDown(hit, { pointerId: 1, clientX: 100, clientY: 10 });
      fireEvent.pointerMove(hit, { pointerId: 1, clientX: 140, clientY: 90 });
      expect(lane("guest").querySelector(".clip-move-ghost")).toBeTruthy();

      // A collaborator adds a chapter and a comment: two marker rows would
      // re-fit the lanes (and move them) under the still pointer.
      act(() => {
        useDawStore.setState({
          project: {
            ...withClip,
            chapters: [{ time: 1, title: "Intro" }],
            comments: [sampleComment()],
          },
        });
      });
      expect(laneHeightVar(container)).toBe("150px");
      document.elementFromPoint = () => lane("host");

      fireEvent.pointerUp(hit, { pointerId: 1, clientX: 140, clientY: 90 });
      expect(execute).toHaveBeenCalledWith(
        "edit.moveClips",
        {
          clips: [
            expect.objectContaining({ clip_id: "c1", track_id: "guest" }),
          ],
        },
        { skipWhen: true },
      );
      // Released: the lanes catch up with the new marker rows.
      expect(laneHeightVar(container)).toBe(
        `${(2 * 150 - MARKER_ROW_HEIGHT) / 2}px`,
      );
    });
  });
});
