import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_PX } from "../utils/timelineZoom.generated";
import { MAX_ZOOM_PX_PER_SEC, ZOOM_STEP } from "../utils/zoom";
import { noteZoomPointerClientX } from "../utils/zoomPointer";
import { useDawStore } from "./dawStore";

type FakeTimelineOptions = {
  left?: number;
  clientWidth?: number;
  /** Sticky header width (`.track-headers` offsetWidth), if any. */
  headerWidth?: number;
  /** Replaces the plain `scrollLeft` field (e.g. a clamping accessor). */
  scrollLeft?: PropertyDescriptor;
};

/** A scroller (400px, no headers, left edge at 0 unless overridden). */
function fakeTimelineEl({
  left = 0,
  clientWidth = 400,
  headerWidth,
  scrollLeft = { value: 0, writable: true },
}: FakeTimelineOptions = {}): HTMLElement {
  const header =
    headerWidth === undefined ? null : { offsetWidth: headerWidth };
  const el = {
    clientWidth,
    getBoundingClientRect: () => ({ left }),
    querySelector: (sel: string) => (sel === ".track-headers" ? header : null),
  };
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    ...scrollLeft,
  });
  return el as unknown as HTMLElement;
}

describe("applyAnchoredZoom", () => {
  beforeEach(() => {
    noteZoomPointerClientX(null);
    useDawStore.setState({ _timelineLeadPx: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates store scroll without writing el.scrollLeft before layout", () => {
    const scrollLeftSetter = vi.fn();
    let domScroll = 0;
    const el = fakeTimelineEl({
      scrollLeft: {
        get: () => domScroll,
        set(v: number) {
          // Simulate pre-zoom clamp: content still only 400px wide.
          const maxScroll = 0;
          domScroll = Math.min(Math.max(0, v), maxScroll);
          scrollLeftSetter(v);
        },
      },
    });

    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 40 / 6, // fitted-ish narrow zoom
      scrollLeft: 0,
      userZoomed: false,
      _timelineEl: el,
    });

    const before = useDawStore.getState().zoomPxPerSec;
    useDawStore.getState().applyAnchoredZoom(before * ZOOM_STEP, 200);

    expect(scrollLeftSetter).not.toHaveBeenCalled();
    const s = useDawStore.getState();
    expect(s.zoomPxPerSec).toBeCloseTo(before * ZOOM_STEP);
    expect(s.scrollLeft).toBeGreaterThan(0);
    expect(s.userZoomed).toBe(true);
    expect(domScroll).toBe(0);
  });

  it("keeps pointer anchor across rapid ticks while DOM scroll is stale", () => {
    const domScroll = 0;
    const el = fakeTimelineEl({
      scrollLeft: {
        get: () => domScroll, // never updated mid-burst
        set() {
          /* ignore — layout not applied yet */
        },
      },
    });

    const startZoom = 10;
    const clientX = 200;
    useDawStore.setState({
      project: { timeline_duration_sec: 120 } as never,
      zoomPxPerSec: startZoom,
      scrollLeft: 100,
      userZoomed: false,
      _timelineEl: el,
    });

    const anchorSec = (clientX - 0 + 100) / startZoom;
    const apply = useDawStore.getState().applyAnchoredZoom;
    apply(useDawStore.getState().zoomPxPerSec * ZOOM_STEP, clientX);
    apply(useDawStore.getState().zoomPxPerSec * ZOOM_STEP, clientX);
    apply(useDawStore.getState().zoomPxPerSec * ZOOM_STEP, clientX);

    const s = useDawStore.getState();
    const timeUnderPointer = (clientX - 0 + s.scrollLeft) / s.zoomPxPerSec;
    expect(timeUnderPointer).toBeCloseTo(anchorSec, 5);
    expect(s.zoomPxPerSec).toBeCloseTo(startZoom * ZOOM_STEP ** 3);
  });

  it("lets a padded fixed-playhead view zoom near 0 without clamping (#385)", () => {
    const el = fakeTimelineEl();
    const base = {
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      userZoomed: false,
      _timelineEl: el,
    };
    // 1 s sits under a pointer at x=210 when the view is scrolled to −200.
    useDawStore.setState({ ...base, scrollLeft: -200, _timelineLeadPx: 200 });
    useDawStore.getState().applyAnchoredZoom(20, 210);
    let s = useDawStore.getState();
    expect((210 + s.scrollLeft) / s.zoomPxPerSec).toBeCloseTo(1, 9);
    expect(s.scrollLeft).toBe(-190);

    // Zooming out there would want −5 px: padded views allow it, unpadded
    // views keep the 0 floor.
    useDawStore.setState({ ...base, scrollLeft: 0, _timelineLeadPx: 200 });
    useDawStore.getState().applyAnchoredZoom(5, 10);
    expect(useDawStore.getState().scrollLeft).toBe(-5);
    useDawStore.setState({ ...base, scrollLeft: 0, _timelineLeadPx: 0 });
    useDawStore.getState().applyAnchoredZoom(5, 10);
    s = useDawStore.getState();
    expect(s.scrollLeft).toBe(0);
  });

  it("ignores a stale touch X for command zoom on a fixed playhead (#385)", () => {
    // Menu and key zoom keep the playhead under the line, wherever the last
    // pointer was.
    noteZoomPointerClientX(50);
    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      playheadSec: 30,
      scrollLeft: 100, // 30 s at the center of a 400px viewport
      userZoomed: false,
      _timelineEl: fakeTimelineEl(),
      _timelineLeadPx: 200,
    });
    useDawStore.getState().applyAnchoredZoom(20);
    const s = useDawStore.getState();
    expect((s.scrollLeft + 200) / s.zoomPxPerSec).toBeCloseTo(30, 9);
  });

  it("centers command zoom on the playhead, not a trailing line (#388)", () => {
    // The line trails the playhead by 0.9 px (under the recenter threshold);
    // repeated zoom-ins must not grow that into a seek.
    useDawStore.setState({
      project: { timeline_duration_sec: 3600 } as never,
      zoomPxPerSec: 1,
      playheadSec: 105,
      scrollLeft: 105 - 200 - 0.9,
      _timelineEl: fakeTimelineEl(),
      _timelineLeadPx: 200,
    });
    for (let i = 0; i < 4; i++) {
      useDawStore
        .getState()
        .applyAnchoredZoom(useDawStore.getState().zoomPxPerSec * ZOOM_STEP);
    }
    const s = useDawStore.getState();
    expect((s.scrollLeft + 200) / s.zoomPxPerSec).toBeCloseTo(105, 9);
  });

  it("keeps pinch zoom within the session on a padded view (#388)", () => {
    // Pinching out near the end must not scroll past the session end.
    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      scrollLeft: 50 * 10 - 200,
      _timelineEl: fakeTimelineEl(),
      _timelineLeadPx: 200,
    });
    useDawStore.getState().applyAnchoredZoom(2.5, 100);
    const s = useDawStore.getState();
    expect((s.scrollLeft + 200) / s.zoomPxPerSec).toBeLessThanOrEqual(60);
  });

  it("keeps a fixed playhead centered through a fit (#385)", () => {
    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      playheadSec: 15,
      zoomPxPerSec: 40,
      scrollLeft: 0,
      _timelineLeadPx: 0,
    });
    useDawStore.getState().fitToWindow(300);
    expect(useDawStore.getState().scrollLeft).toBe(0);

    useDawStore.setState({ _timelineLeadPx: 150 });
    useDawStore.getState().fitToWindow(300);
    const s = useDawStore.getState();
    expect((s.scrollLeft + 150) / s.zoomPxPerSec).toBeCloseTo(15, 9);
    expect(s.userZoomed).toBe(false);
  });

  it("anchors keyboard zoom at last noted pointer X when set", () => {
    const el = fakeTimelineEl({ left: 100 });

    noteZoomPointerClientX(250); // 150px into the viewport
    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      scrollLeft: 50,
      userZoomed: false,
      _timelineEl: el,
    });

    const anchorSec = (250 - 100 + 50) / 10;
    useDawStore.getState().applyAnchoredZoom(10 * ZOOM_STEP);
    const s = useDawStore.getState();
    expect((250 - 100 + s.scrollLeft) / s.zoomPxPerSec).toBeCloseTo(
      anchorSec,
      5,
    );
  });

  it("anchors off-center clientX rather than viewport middle", () => {
    const el = fakeTimelineEl();

    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      scrollLeft: 0,
      userZoomed: false,
      _timelineEl: el,
    });

    const leftX = 50;
    const centerX = 200;
    useDawStore.getState().applyAnchoredZoom(20, leftX);
    const leftScroll = useDawStore.getState().scrollLeft;

    useDawStore.setState({ zoomPxPerSec: 10, scrollLeft: 0 });
    useDawStore.getState().applyAnchoredZoom(20, centerX);
    const centerScroll = useDawStore.getState().scrollLeft;

    expect(leftScroll).not.toBeCloseTo(centerScroll, 0);
    expect(leftScroll).toBeLessThan(centerScroll);
  });

  it("ignores sticky track-header width for fit measure and zoom origin", () => {
    const el = fakeTimelineEl({ left: 40, clientWidth: 580, headerWidth: 180 });

    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      scrollLeft: 0,
      userZoomed: false,
      _timelineEl: el,
    });

    expect(useDawStore.getState().measureTimelineViewport()).toBe(400);

    const clientX = 40 + 180 + 100; // 100px into the time column
    const before = useDawStore.getState().zoomPxPerSec;
    const anchorSec = (clientX - (40 + 180) + 0) / before;
    useDawStore.getState().applyAnchoredZoom(before * ZOOM_STEP, clientX);
    const s = useDawStore.getState();
    expect((clientX - (40 + 180) + s.scrollLeft) / s.zoomPxPerSec).toBeCloseTo(
      anchorSec,
      5,
    );
  });

  it("stops zooming in at the session-aware ceiling", () => {
    const zoomIn = (times: number) => {
      for (let i = 0; i < times; i++) {
        useDawStore
          .getState()
          .applyAnchoredZoom(
            useDawStore.getState().zoomPxPerSec * ZOOM_STEP,
            0,
          );
      }
    };
    // A 60 s session reaches the 48,000 px/s cap.
    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      scrollLeft: 0,
      _timelineEl: fakeTimelineEl(),
    });
    zoomIn(50);
    expect(useDawStore.getState().zoomPxPerSec).toBe(MAX_ZOOM_PX_PER_SEC);

    // An hour stops where its content would pass MAX_CONTENT_PX.
    useDawStore.setState({
      project: { timeline_duration_sec: 3600 } as never,
      zoomPxPerSec: 10,
      scrollLeft: 0,
    });
    zoomIn(50);
    const z = useDawStore.getState().zoomPxPerSec;
    expect(z).toBeCloseTo(MAX_CONTENT_PX / 3600, 6);
    expect(z * 3600).toBeLessThanOrEqual(MAX_CONTENT_PX + 1e-6);
  });

  it("clamps setZoomPxPerSec to the session ceiling", () => {
    useDawStore.setState({ project: { timeline_duration_sec: 3600 } as never });
    useDawStore.getState().setZoomPxPerSec(1e9);
    expect(useDawStore.getState().zoomPxPerSec * 3600).toBeLessThanOrEqual(
      MAX_CONTENT_PX + 1e-6,
    );
  });

  it("reclamps zoom around the view centre when the session grows", () => {
    useDawStore.setState({
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 48000,
      scrollLeft: 30 * 48000 - 200, // 30 s at the centre of 400 px
      _timelineEl: fakeTimelineEl(),
      _timelineLeadPx: 0,
    });
    useDawStore.getState().setProject({ timeline_duration_sec: 3600 } as never);
    const s = useDawStore.getState();
    expect(s.zoomPxPerSec).toBeCloseTo(MAX_CONTENT_PX / 3600, 6);
    expect((s.scrollLeft + 200) / s.zoomPxPerSec).toBeCloseTo(30, 9);

    // A zoom under the new ceiling is left alone.
    useDawStore.setState({ zoomPxPerSec: 10, scrollLeft: 5 });
    useDawStore.getState().reclampZoomForDuration();
    expect(useDawStore.getState().zoomPxPerSec).toBe(10);
    expect(useDawStore.getState().scrollLeft).toBe(5);
  });

  it("uses visualViewport CSS px when no timeline element is registered", () => {
    vi.stubGlobal("visualViewport", { width: 390 });
    vi.stubGlobal("innerWidth", 1280);
    useDawStore.setState({
      _timelineEl: null,
      shellBreakpoint: "phone",
    });
    expect(useDawStore.getState().measureTimelineViewport()).toBe(390);
  });
});
