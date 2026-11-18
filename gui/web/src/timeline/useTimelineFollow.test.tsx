import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import { minimalProject } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import { useFixedPlayheadScroll } from "./useFixedPlayheadScroll";
import { TimelineFollow } from "./useTimelineFollow";

const ZOOM = 10;
const VIEWPORT = 400;

const flag = () => useDawStore.getState().timelineFollowPlayhead;
const setFlag = (on: boolean) =>
  useDawStore.setState({ timelineFollowPlayhead: on });

describe("TimelineFollow", () => {
  let raf: ReturnType<typeof stubRaf>;
  let el: HTMLDivElement;
  let clientWidth: number;
  let scrollWidth: number;
  let left: number;
  let scrollTo: ReturnType<typeof vi.fn<() => void>>;
  let domWrites: number[];
  let storeWrites: number[];
  const realSetScrollLeft = useDawStore.getState().setScrollLeft;

  beforeEach(() => {
    raf = stubRaf();
    clientWidth = VIEWPORT;
    scrollWidth = 3000;
    left = 0;
    domWrites = [];
    storeWrites = [];
    el = document.createElement("div");
    Object.defineProperties(el, {
      clientWidth: { get: () => clientWidth, configurable: true },
      scrollWidth: { get: () => scrollWidth, configurable: true },
      scrollLeft: {
        configurable: true,
        get: () => left,
        set: (value: number) => {
          left = Math.max(0, Math.min(value, scrollWidth - clientWidth));
          domWrites.push(left);
        },
      },
    });
    scrollTo = vi.fn<() => void>();
    el.scrollTo = scrollTo;
    document.body.append(el);
    useDawStore
      .getState()
      .hydrate(
        "/tmp/timeline-follow.json",
        minimalProject({ timeline_duration_sec: 300 }),
      );
    useDawStore.setState({
      zoomPxPerSec: ZOOM,
      userZoomed: true,
      followingClientId: null,
      playheadSec: 0,
      scrollLeft: 0,
      isPlaying: true,
      setScrollLeft: (px: number) => {
        storeWrites.push(px);
        realSetScrollLeft(px);
      },
    });
    setFlag(true);
  });

  afterEach(() => {
    cleanup();
    useDawStore.setState({
      setScrollLeft: realSetScrollLeft,
      isPlaying: false,
    });
    raf.fire(0);
    el.remove();
    timelineViewportRegistry.clear();
    vi.unstubAllGlobals();
  });

  function Harness({
    sessionSec = 300,
    timeViewportPx = VIEWPORT,
    fixedPlayhead = false,
  }: {
    sessionSec?: number;
    timeViewportPx?: number;
    fixedPlayhead?: boolean;
  }) {
    const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
    const scroll = useFixedPlayheadScroll({
      scrollRef: { current: el },
      fixedPlayhead,
      timeViewportPx,
      sessionSec,
      zoomPxPerSec,
      followingClientId: null,
    });
    useLayoutEffect(() => {
      el.addEventListener("scroll", scroll.onScroll);
      return () => el.removeEventListener("scroll", scroll.onScroll);
    }, [scroll.onScroll]);
    return <TimelineFollow binding={scroll.binding} sessionSec={sessionSec} />;
  }

  const tick = (sec: number) =>
    act(() => useDawStore.getState().setPlayheadSec(sec, "playback"));
  const seek = (sec: number) =>
    act(() => useDawStore.getState().setPlayheadSec(sec));
  const scrollEvent = () =>
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
  const playheadX = () =>
    useDawStore.getState().playheadSec * ZOOM - el.scrollLeft;

  it("pages the view when a playing playhead reaches the right margin", () => {
    render(<Harness />);
    tick(30);
    tick(36);
    expect(el.scrollLeft).toBe(0);
    tick(37);
    expect(el.scrollLeft).toBe(310);
    expect(useDawStore.getState().scrollLeft).toBe(310);
    expect(playheadX()).toBe(60);
    expect(flag()).toBe(true);
  });

  it("pages back when the playhead is left of the view", () => {
    left = 1000;
    useDawStore.setState({ scrollLeft: 1000, playheadSec: 120 });
    render(<Harness />);
    tick(20);
    expect(el.scrollLeft).toBe(140);
    expect(useDawStore.getState().scrollLeft).toBe(140);
  });

  it("does not write scroll while the playhead is inside the margin", () => {
    render(<Harness />);
    for (let i = 1; i <= 60; i += 1) tick(i / 20);
    expect(domWrites).toEqual([]);
    expect(storeWrites).toEqual([]);
  });

  it("clamps at the content end and makes no further writes or store updates on later ticks", () => {
    scrollWidth = 600;
    render(<Harness sessionSec={60} />);
    tick(50);
    expect(el.scrollLeft).toBe(200);
    for (let i = 0; i < 60; i += 1) tick(55 + i / 12);
    expect(domWrites).toEqual([200]);
    expect(storeWrites).toEqual([200]);
  });

  it("a seek during playback reveals an off-screen playhead centered and keeps the flag on", () => {
    render(<Harness />);
    seek(100);
    expect(el.scrollLeft).toBe(800);
    expect(useDawStore.getState().scrollLeft).toBe(800);
    expect(flag()).toBe(true);
  });

  it("a seek that lands in view leaves the view alone", () => {
    render(<Harness />);
    seek(20);
    expect(domWrites).toEqual([]);
  });

  it("a seek reveals the playhead but does not re-arm a suspended follow", () => {
    render(<Harness />);
    setFlag(false);
    seek(100);
    expect(el.scrollLeft).toBe(800);
    expect(flag()).toBe(false);
  });

  it("an audition stop's seek back to its start reveals the playhead before pausing", () => {
    left = 800;
    useDawStore.setState({ scrollLeft: 800, playheadSec: 100 });
    render(<Harness />);
    act(() => {
      useDawStore.getState().setPlayheadSec(5);
      useDawStore.getState().setIsPlaying(false);
    });
    expect(el.scrollLeft).toBe(0);
  });

  it("a seek while paused does not move the view", () => {
    useDawStore.setState({ isPlaying: false });
    render(<Harness />);
    seek(100);
    expect(domWrites).toEqual([]);
    expect(storeWrites).toEqual([]);
  });

  it("Play start re-arms the flag and centers an off-screen playhead, and leaves a visible one", () => {
    useDawStore.setState({ isPlaying: false, playheadSec: 100 });
    setFlag(false);
    render(<Harness />);
    act(() => useDawStore.getState().setIsPlaying(true));
    expect(flag()).toBe(true);
    expect(el.scrollLeft).toBe(800);

    act(() => useDawStore.getState().setIsPlaying(false));
    useDawStore.setState({ playheadSec: 85 });
    setFlag(false);
    domWrites.length = 0;
    act(() => useDawStore.getState().setIsPlaying(true));
    expect(flag()).toBe(true);
    expect(domWrites).toEqual([]);
  });

  it("does not page while the follow is suspended", () => {
    render(<Harness />);
    setFlag(false);
    tick(50);
    tick(80);
    expect(domWrites).toEqual([]);
    expect(storeWrites).toEqual([]);
  });

  it("our own page write and its late echo do not clear the flag", () => {
    render(<Harness />);
    tick(37);
    expect(el.scrollLeft).toBe(310);
    scrollEvent();
    expect(flag()).toBe(true);
    act(() => raf.fire(0));
    scrollEvent();
    expect(flag()).toBe(true);
  });

  it("a browser clamp after a resize does not clear the flag", () => {
    left = 2600;
    useDawStore.setState({ scrollLeft: 2600, playheadSec: 270 });
    const view = render(<Harness />);
    act(() => raf.fire(0));
    clientWidth = 600;
    left = Math.min(left, scrollWidth - clientWidth);
    expect(left).toBe(2400);
    view.rerender(<Harness timeViewportPx={600} />);
    scrollEvent();
    expect(flag()).toBe(true);
    el.scrollLeft = 2300;
    scrollEvent();
    expect(flag()).toBe(false);
  });

  it("is inert with a fixed playhead", () => {
    render(<Harness fixedPlayhead />);
    tick(50);
    seek(100);
    expect(domWrites).toEqual([]);
    expect(storeWrites).toEqual([]);
  });

  it("is inert while following another person", () => {
    useDawStore.setState({ followingClientId: "leader" });
    render(<Harness />);
    tick(50);
    seek(100);
    expect(domWrites).toEqual([]);
    expect(storeWrites).toEqual([]);
  });

  it("writes instantly through the scroll offset, never a smooth scrollTo", () => {
    render(<Harness />);
    tick(37);
    seek(150);
    expect(domWrites).toEqual([310, 1300]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("pages to the new zoom's canvas, not the last committed one", () => {
    left = 2000;
    useDawStore.setState({ scrollLeft: 2000, playheadSec: 230 });
    render(<Harness />);
    scrollWidth = 6000;
    act(() => useDawStore.setState({ zoomPxPerSec: 20 }));
    expect(domWrites).toEqual([4540]);
  });

  it("a timeline that mounts follows again, whatever an earlier one left behind", () => {
    setFlag(false);
    render(<Harness />);
    expect(flag()).toBe(true);
  });
});
