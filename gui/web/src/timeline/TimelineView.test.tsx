import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleComment } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import type { ClipRow, ProjectView } from "../types/project";
import {
  COMPACT_LANE_HEIGHT,
  FIT_GUTTER,
  LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  RULER_HEIGHT,
} from "../utils/layout";
import {
  domToLogicalScrollLeft,
  scrollLeftToCenterSec,
} from "../utils/timelineViewport";
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
  let raf: ReturnType<typeof stubRaf>;

  // 400px scroller, no header column: lead = 200px, 10px/s, 60 s session.
  beforeEach(async () => {
    // Earlier tests queue programmatic-scroll frames on the real clock; let
    // them run (in order) so followSync's module-level counter starts at 0.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    RecordingResizeObserver.all = [];
    vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
    raf = stubRaf();
    stubElementSize(400, 600);
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
    // Run the frames still queued, or followSync's module-level programmatic
    // counter stays raised for the next test.
    raf.fire(0);
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  /** Mount with a scroller whose scrollLeft is plain storage (jsdom's isn't). */
  function mountFixed(headerSlot?: ReactNode) {
    const view = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView fixedPlayhead headerSlot={headerSlot} />
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
    // Next frame: the programmatic-scroll flags clear.
    const settle = () => act(() => raf.fire(0));
    return { ...view, scroller, userScrollTo, settle };
  }

  it("pads the time column by half the viewport and registers the lead", () => {
    const { container } = mountFixed();
    const area = container.querySelector(".timeline-area") as HTMLElement;
    expect(area.style.getPropertyValue("--timeline-lead")).toBe("200px");
    expect(area.style.getPropertyValue("--timeline-fixed-line")).toBe("200px");
    expect(useDawStore.getState()._timelineLeadPx).toBe(200);
  });

  it("treats a write's late echo as programmatic, a person's scroll as not", () => {
    const { scroller, userScrollTo, settle } = mountFixed();
    act(() => {
      useDawStore.getState().setPlayheadSec(15);
    });
    // Recentered: 15 s × 10 px/s − 200 px center = −50 logical, 150 DOM.
    expect(scroller.scrollLeft).toBe(150);
    expect(useDawStore.getState().scrollLeft).toBe(-50);
    act(() => {
      useDawStore.setState({ followingClientId: "leader" });
    });

    // The write's scroll event can land after the programmatic flags clear:
    // it must neither unfollow nor seek.
    settle();
    userScrollTo(150);
    expect(useDawStore.getState().followingClientId).toBe("leader");

    userScrollTo(250); // a person: 100 px further, 10 s later
    expect(useDawStore.getState().followingClientId).toBeNull();
    expect(useDawStore.getState().playheadSec).toBeCloseTo(25, 9);

    userScrollTo(250.5); // under a pixel: not a move
    expect(useDawStore.getState().playheadSec).toBeCloseTo(25, 9);
  });

  it("ends the scroll range at the session end below fit zoom (#388)", () => {
    // 5 px/s is below fit (400 px / 60 s): the canvas is the session, so the
    // largest DOM scroll (lead + 300 + lead − 400) puts 60 s under the line
    // with no write back.
    useDawStore.setState({ zoomPxPerSec: 5 });
    const { container, scroller, userScrollTo, settle } = mountFixed();
    const time = container.querySelector(".timeline-time") as HTMLElement;
    expect(time.style.width).toBe("300px");
    settle();
    userScrollTo(300);
    expect(useDawStore.getState().playheadSec).toBe(60);
    expect(scroller.scrollLeft).toBe(300);
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
    const logical = domToLogicalScrollLeft(scroller.scrollLeft, 200);
    expect(scrollLeftToCenterSec(logical, s.zoomPxPerSec, 400, 60)).toBeCloseTo(
      15,
      9,
    );
  });

  it("refits on a new width only, not a height or header entry (#388)", () => {
    const fit = vi.fn(fitToWindow);
    useDawStore.setState({ userZoomed: false, fitToWindow: fit });
    const { container } = mountFixed(<div className="track-headers" />);
    expect(fit).toHaveBeenCalledTimes(1);
    const ro = RecordingResizeObserver.all.find((o) =>
      o.targets.includes(
        container.querySelector(".timeline-scroll") as Element,
      ),
    );
    expect(ro).toBeTruthy();
    const header = container.querySelector(".track-headers") as Element;
    expect(ro?.targets).toContain(header);

    act(() => ro?.fire(400, 700)); // height only
    act(() => ro?.fire(400, 700, header)); // header entry, same width
    expect(fit).toHaveBeenCalledTimes(1);

    act(() => ro?.fire(500, 700));
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fit).toHaveBeenLastCalledWith(500);
  });

  it("leaves no scroll before 0 or lead behind when unmounted", () => {
    const { unmount } = mountFixed();
    act(() => {
      useDawStore.getState().setPlayheadSec(5);
    });
    expect(useDawStore.getState().scrollLeft).toBe(-150);
    unmount();
    expect(useDawStore.getState().scrollLeft).toBe(0);
    expect(useDawStore.getState()._timelineLeadPx).toBe(0);
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
  /** Resize the stubbed elements, then notify for `target` (the scroller). */
  fire(width: number, height: number, target = this.targets[0]): void {
    stubElementSize(width, height);
    this.cb(
      [{ target, contentRect: { width, height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/** Every element's clientWidth/clientHeight, as a resize would change them. */
const stubbedSize = { width: 0, height: 0 };

function stubElementSize(width: number, height: number): void {
  stubbedSize.width = width;
  stubbedSize.height = height;
  for (const [prop, key] of [
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => stubbedSize[key],
    });
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
    stubElementSize(800, chrome + 2 * 150);
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

  it("renders the stage edges after the scroller, over the lane floor (#387)", () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={twoTrackProject()}>
        <TimelineView headerSlot={<div className="track-headers" />} />
      </DawProvider>,
    );
    // At the lane floor's z, tree order decides: edges before the scroller
    // would paint under the lane rows.
    const area = container.querySelector(".timeline-area") as HTMLElement;
    const children = [...area.children].map((el) => el.className);
    const scroller = children.indexOf("timeline-scroll");
    expect(children.slice(scroller + 1)).toEqual([
      "timeline-edge timeline-edge--start",
      "timeline-edge timeline-edge--end",
    ]);
    for (const edge of area.querySelectorAll(".timeline-edge")) {
      expect(edge.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("insets the stage edges by the header column and scrollbars (#387)", () => {
    let headerPx = 180;
    // Classic scrollbars: 15px beside the scrollport, 12px below it.
    const sides = {
      offsetWidth: { size: "width", scrollbar: 15, header: () => headerPx },
      offsetHeight: { size: "height", scrollbar: 12, header: () => 0 },
    } as const;
    const spies = (["offsetWidth", "offsetHeight"] as const).map((prop) =>
      vi.spyOn(HTMLElement.prototype, prop, "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        const side = sides[prop];
        if (this.classList.contains("track-headers")) {
          return side.header();
        }
        return this.classList.contains("timeline-scroll")
          ? stubbedSize[side.size] + side.scrollbar
          : 0;
      }),
    );
    try {
      const { container } = render(
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={twoTrackProject()}
        >
          <TimelineView headerSlot={<div className="track-headers" />} />
        </DawProvider>,
      );
      const area = container.querySelector(".timeline-area") as HTMLElement;
      const edge = (name: string) => area.style.getPropertyValue(name);
      // In every mode, not only under the phone's fixed playhead.
      expect(edge("--timeline-header-offset")).toBe("180px");
      expect(edge("--timeline-scrollbar-inline")).toBe("15px");
      expect(edge("--timeline-scrollbar-block")).toBe("12px");

      // A header-only resize (a density switch) reaches the edge too.
      const header = container.querySelector(".track-headers") as Element;
      const ro = RecordingResizeObserver.all.find((o) =>
        o.targets.includes(header),
      );
      headerPx = 140;
      act(() => ro?.fire(stubbedSize.width, stubbedSize.height, header));
      expect(edge("--timeline-header-offset")).toBe("140px");
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
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
