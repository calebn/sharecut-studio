import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZOOM_STEP } from "../utils/zoom";
import { noteZoomPointerClientX } from "../utils/zoomPointer";
import { useDawStore } from "./dawStore";

describe("applyAnchoredZoom", () => {
  beforeEach(() => {
    noteZoomPointerClientX(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates store scroll without writing el.scrollLeft before layout", () => {
    const scrollLeftSetter = vi.fn();
    let domScroll = 0;
    const el = {
      clientWidth: 400,
      get scrollLeft() {
        return domScroll;
      },
      set scrollLeft(v: number) {
        // Simulate pre-zoom clamp: content still only 400px wide.
        const maxScroll = 0;
        domScroll = Math.min(Math.max(0, v), maxScroll);
        scrollLeftSetter(v);
      },
      getBoundingClientRect: () => ({ left: 0 }),
      querySelector: () => null,
    } as unknown as HTMLElement;

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
    const el = {
      clientWidth: 400,
      get scrollLeft() {
        return domScroll; // never updated mid-burst
      },
      set scrollLeft(_v: number) {
        /* ignore — layout not applied yet */
      },
      getBoundingClientRect: () => ({ left: 0 }),
      querySelector: () => null,
    } as unknown as HTMLElement;

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
    const el = {
      clientWidth: 400,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0 }),
      querySelector: () => null,
    } as unknown as HTMLElement;
    const base = {
      project: { timeline_duration_sec: 60 } as never,
      zoomPxPerSec: 10,
      userZoomed: false,
      _timelineEl: el,
    };
    // 1 s sits under a pointer at x=210 when the view is scrolled to −200.
    useDawStore.setState({ ...base, scrollLeft: -200, timelineLeadPx: 200 });
    useDawStore.getState().applyAnchoredZoom(20, 210);
    let s = useDawStore.getState();
    expect((210 + s.scrollLeft) / s.zoomPxPerSec).toBeCloseTo(1, 9);
    expect(s.scrollLeft).toBe(-190);

    // Zooming out there would want −5 px: padded views allow it, unpadded
    // views keep the 0 floor.
    useDawStore.setState({ ...base, scrollLeft: 0, timelineLeadPx: 200 });
    useDawStore.getState().applyAnchoredZoom(5, 10);
    expect(useDawStore.getState().scrollLeft).toBe(-5);
    useDawStore.setState({ ...base, scrollLeft: 0, timelineLeadPx: 0 });
    useDawStore.getState().applyAnchoredZoom(5, 10);
    s = useDawStore.getState();
    expect(s.scrollLeft).toBe(0);
  });

  it("anchors keyboard zoom at last noted pointer X when set", () => {
    const el = {
      clientWidth: 400,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 100 }),
      querySelector: () => null,
    } as unknown as HTMLElement;

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
    const el = {
      clientWidth: 400,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0 }),
      querySelector: () => null,
    } as unknown as HTMLElement;

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
    const header = { offsetWidth: 180 };
    const el = {
      clientWidth: 580,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 40 }),
      querySelector: (sel: string) =>
        sel === ".track-headers" ? header : null,
    } as unknown as HTMLElement;

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
