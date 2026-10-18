import { act, cleanup, render, renderHook } from "@testing-library/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import { minimalProject, recordSnapshot } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import { FixedPlayheadNeedle } from "./FixedPlayheadNeedle";
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
    Object.defineProperty(el, "clientWidth", {
      value: 400,
      configurable: true,
    });
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
    cleanup();
    useRecordHostStore.getState().setSnapshot(null);
    raf.fire(0);
    el.remove();
    timelineViewportRegistry.clear();
    vi.unstubAllGlobals();
  });

  function MountedTimeline({
    children,
    timeViewportPx = 400,
    fixedPlayhead = true,
  }: {
    children?: ReactNode;
    timeViewportPx?: number;
    fixedPlayhead?: boolean;
  }) {
    const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
    const scroll = useFixedPlayheadScroll({
      ...input,
      zoomPxPerSec,
      timeViewportPx,
      fixedPlayhead,
    });
    useLayoutEffect(() => {
      el.addEventListener("scroll", scroll.onScroll);
      return () => el.removeEventListener("scroll", scroll.onScroll);
    }, [scroll.onScroll]);
    return (
      <>
        <TimelineScrollSync binding={scroll.binding} />
        <FixedPlayheadRecenter binding={scroll.binding} />
        <FixedPlayheadNeedle
          headerOffsetPx={0}
          timeViewportPx={timeViewportPx}
        />
        {children}
      </>
    );
  }

  it.each([false, true])(
    "keeps saved-end intent when a resize clamps the browser before measurement, delayed echo %s",
    (delayedEcho) => {
      let clientWidth = 600;
      let scrollWidth = 2030;
      let left = 0;
      Object.defineProperties(el, {
        clientWidth: { get: () => clientWidth },
        scrollWidth: { get: () => scrollWidth },
        scrollLeft: {
          get: () => left,
          set: (value: number) => {
            left = Math.max(0, Math.min(value, el.scrollWidth - clientWidth));
          },
        },
      });
      const header = document.createElement("div");
      header.className = "track-headers";
      Object.defineProperty(header, "offsetWidth", { value: 140 });
      el.append(header);
      useDawStore
        .getState()
        .hydrate(
          "/tmp/scroll-hook.json",
          minimalProject({ timeline_duration_sec: 120 }),
        );
      useDawStore.setState({
        scrollLeft: 1200,
        playheadSec: 120,
        playheadSeekRevision: 3,
        followingClientId: "leader",
      });
      input = { ...input, sessionSec: 120, followingClientId: "leader" };
      const view = render(<MountedTimeline timeViewportPx={460} />);
      act(() => raf.fire(0));
      expect(el.scrollLeft).toBe(1430);

      // Native layout clamps against the old extent before ResizeObserver measures.
      clientWidth = 640;
      left = Math.min(left, el.scrollWidth - clientWidth);
      expect(el.scrollLeft).toBe(1390);
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      expect.soft(useDawStore.getState().playheadSec).toBe(120);
      expect.soft(useDawStore.getState().playheadSeekRevision).toBe(3);
      expect.soft(useDawStore.getState().followingClientId).toBe("leader");
      expect.soft(useDawStore.getState().scrollLeft).toBe(1200);

      scrollWidth = 2090;
      view.rerender(<MountedTimeline timeViewportPx={500} />);
      expect(useDawStore.getState().playheadSec).toBe(120);
      expect(useDawStore.getState().playheadSeekRevision).toBe(3);
      expect(useDawStore.getState().scrollLeft).toBe(1200);
      expect(el.scrollLeft).toBe(1450);
      act(() => raf.fire(0));
      if (delayedEcho) {
        act(() => {
          el.dispatchEvent(new Event("scroll"));
        });
        expect(useDawStore.getState().playheadSec).toBe(120);
        expect(useDawStore.getState().playheadSeekRevision).toBe(3);
        expect(useDawStore.getState().followingClientId).toBe("leader");
      }
      el.scrollLeft = 1400;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      expect(useDawStore.getState().playheadSec).toBe(115);
      expect(useDawStore.getState().playheadSeekRevision).toBe(4);
      expect(useDawStore.getState().scrollLeft).toBe(1150);
      expect(useDawStore.getState().followingClientId).toBeNull();
    },
  );

  it("restores a preview pan after an ordinary tablet timeline mounts", () => {
    Object.defineProperty(el, "clientWidth", { value: 460 });
    useRecordHostStore.getState().setSnapshot(
      recordSnapshot({
        state: "paused",
        timeline_start_sec: 0,
        recording_ms: 200_000,
      }),
    );
    useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
    const revision = useDawStore.getState().playheadSeekRevision;
    const phone = render(<MountedTimeline timeViewportPx={460} />);
    act(() => raf.fire(0));
    el.scrollLeft = 780;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().scrollLeft).toBe(550);
    expect(useDawStore.getState().playheadSec).toBe(20);
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision);

    phone.unmount();
    el.scrollLeft = 0;
    const tablet = render(
      <MountedTimeline fixedPlayhead={false} timeViewportPx={660} />,
    );
    expect(useDawStore.getState().scrollLeft).toBe(550);
    expect(useDawStore.getState().playheadSec).toBe(20);
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
    tablet.unmount();
    el.scrollLeft = 0;
    render(<MountedTimeline timeViewportPx={460} />);
    expect.soft(useDawStore.getState().scrollLeft).toBe(550);
    expect.soft(el.scrollLeft).toBe(780);
    expect(useDawStore.getState().playheadSec).toBe(20);
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
  });

  it.each([
    "return",
    "tablet scroll",
    "same-time seek",
    "Fit",
    "project switch",
    "preview end",
    "absent preview end",
    "pointer zoom",
  ])("projects a constrained tablet pan through %s", (action) => {
    let clientWidth = 600;
    let scrollWidth = 2830;
    let left = 0;
    let assignments = 0;
    Object.defineProperties(el, {
      clientWidth: { get: () => clientWidth },
      scrollWidth: { get: () => scrollWidth },
      scrollLeft: {
        get: () => left,
        set: (value: number) => {
          assignments++;
          left = Math.max(0, Math.min(value, scrollWidth - clientWidth));
        },
      },
    });
    const header = document.createElement("div");
    header.className = "track-headers";
    Object.defineProperty(header, "offsetWidth", { value: 140 });
    el.append(header);
    useRecordHostStore
      .getState()
      .setSnapshot(recordSnapshot({ state: "paused", recording_ms: 200_000 }));
    useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
    const revision = useDawStore.getState().playheadSeekRevision;
    const phone = render(<MountedTimeline timeViewportPx={460} />);
    act(() => raf.fire(0));
    el.scrollLeft = 1430;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().scrollLeft).toBe(1200);
    phone.unmount();

    clientWidth = 768;
    scrollWidth = 1341;
    left = 0;
    assignments = 0;
    const tablet = render(
      <MountedTimeline fixedPlayhead={false} timeViewportPx={628} />,
    );
    expect.soft(el.scrollLeft).toBe(573);
    expect.soft(useDawStore.getState().scrollLeft).toBe(573);
    expect(assignments).toBe(1);
    const away = [
      "same-time seek",
      "Fit",
      "project switch",
      "absent preview end",
    ].includes(action);
    if (away) tablet.unmount();
    if (action === "tablet scroll") {
      act(() => raf.fire(0));
      el.scrollLeft = 400;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      el.scrollLeft = 573;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
    } else if (action === "same-time seek") {
      act(() => useDawStore.getState().setPlayheadSec(20));
    } else if (action === "Fit") {
      act(() => useDawStore.getState().fitToWindow(628));
    } else if (action === "project switch") {
      act(() =>
        useDawStore
          .getState()
          .hydrate("/tmp/another-scroll-hook.json", minimalProject()),
      );
    } else if (action === "preview end") {
      act(() => useRecordHostStore.getState().setSnapshot(null));
      act(() =>
        useRecordHostStore
          .getState()
          .setSnapshot(
            recordSnapshot({ state: "paused", recording_ms: 200_000 }),
          ),
      );
    } else if (action === "absent preview end") {
      act(() =>
        useRecordHostStore
          .getState()
          .setSnapshot(recordSnapshot({ state: "stopped", server_time_ns: 2 })),
      );
      expect(useRecordHostStore.getState().snapshot?.state).toBe("stopped");
      act(() =>
        useRecordHostStore.getState().setSnapshot(
          recordSnapshot({
            state: "paused",
            take_index: 1,
            server_time_ns: 3,
            recording_ms: 200_000,
          }),
        ),
      );
      expect(useRecordHostStore.getState().snapshot?.take_index).toBe(1);
    } else if (action === "pointer zoom") {
      timelineViewportRegistry.setTimelineElement(el);
      act(() => useDawStore.getState().applyAnchoredZoom(5, 250));
    }
    if (!away) tablet.unmount();
    clientWidth = action === "pointer zoom" ? 390 : 600;
    scrollWidth = 2830;
    left = 0;
    const returnedWidth = clientWidth - 140;
    render(<MountedTimeline timeViewportPx={returnedWidth} />);
    if (action === "return") {
      expect.soft(el.scrollLeft).toBe(1430);
      expect.soft(useDawStore.getState().scrollLeft).toBe(1200);
    } else {
      expect(useDawStore.getState().scrollLeft).not.toBe(1200);
      expect(el.scrollLeft).toBe(
        useDawStore.getState().scrollLeft + returnedWidth / 2,
      );
      if (action === "pointer zoom") {
        expect(useDawStore.getState().scrollLeft).toBe(231.5);
      } else if (action === "absent preview end") {
        expect(useDawStore.getState().scrollLeft).toBe(0);
        expect(timelineViewportRegistry.getVisualPan()).toBeNull();
      }
    }
    expect(useDawStore.getState().playheadSec).toBe(
      action === "project switch" ? 0 : 20,
    );
    expect(useDawStore.getState().playheadSeekRevision).toBe(
      revision + (action === "same-time seek" ? 1 : 0),
    );
  });

  it.each([
    { tabletWidth: 800, requestedLeft: 215.5, appliedLeft: 216 },
    { tabletWidth: 768, requestedLeft: 231.5, appliedLeft: 232 },
  ])(
    "retains original preview geometry through integer rounding at $tabletWidth px",
    ({ tabletWidth, requestedLeft, appliedLeft }) => {
      let clientWidth = 600;
      let headerWidth = 140;
      let scrollWidth = 2030;
      let left = 0;
      let assignments = 0;
      Object.defineProperties(el, {
        clientWidth: { get: () => clientWidth },
        scrollWidth: { get: () => scrollWidth },
        scrollLeft: {
          get: () => left,
          set: (value: number) => {
            assignments++;
            left = Math.round(
              Math.max(0, Math.min(value, scrollWidth - clientWidth)),
            );
          },
        },
      });
      const header = document.createElement("div");
      header.className = "track-headers";
      Object.defineProperty(header, "offsetWidth", { get: () => headerWidth });
      el.append(header);
      useDawStore
        .getState()
        .hydrate(
          "/tmp/scroll-hook.json",
          minimalProject({ timeline_duration_sec: 120 }),
        );
      useRecordHostStore
        .getState()
        .setSnapshot(
          recordSnapshot({ state: "paused", recording_ms: 120_000 }),
        );
      useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
      const revision = useDawStore.getState().playheadSeekRevision;
      const phone = render(<MountedTimeline timeViewportPx={460} />);
      act(() => raf.fire(0));
      el.scrollLeft = 1430;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      expect(
        timelineViewportRegistry.getVisualPan()?.geometry.lineOffsetPx,
      ).toBe(100);
      phone.unmount();

      clientWidth = tabletWidth;
      scrollWidth = 1341;
      left = 0;
      const tablet = render(
        <MountedTimeline
          fixedPlayhead={false}
          timeViewportPx={clientWidth - headerWidth}
        />,
      );
      expect(useDawStore.getState().scrollLeft).toBe(scrollWidth - clientWidth);
      timelineViewportRegistry.setTimelineElement(el);
      scrollWidth = headerWidth + Math.max(120 * 5, clientWidth - headerWidth);
      act(() => useDawStore.getState().applyAnchoredZoom(5, 250));
      expect(useDawStore.getState().scrollLeft).toBe(0);
      expect(
        timelineViewportRegistry.getLayoutProjection()?.requestedLeft,
      ).toBe(requestedLeft);
      tablet.unmount();

      clientWidth = 390;
      headerWidth = 64;
      scrollWidth = headerWidth + 120 * 5 + 163 + 326;
      left = 0;
      assignments = 0;
      const returned = render(<MountedTimeline timeViewportPx={326} />);
      expect.soft(useDawStore.getState().scrollLeft).toBe(appliedLeft);
      expect.soft(el.scrollLeft).toBe(appliedLeft + 163);
      expect
        .soft(timelineViewportRegistry.getVisualPan()?.geometry)
        .toEqual({ scrollLeft: 1200, lineOffsetPx: 100, zoomPxPerSec: 10 });
      expect.soft(assignments).toBe(1);
      act(() => raf.fire(0));
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      returned.rerender(<MountedTimeline timeViewportPx={326} />);
      expect.soft(assignments).toBe(1);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
    },
  );

  it.each(["stopped", null] as const)(
    "recenters a mounted phone preview when its snapshot ends in %s",
    (state) => {
      useRecordHostStore
        .getState()
        .setSnapshot(recordSnapshot({ state: "paused", server_time_ns: 1 }));
      useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
      const revision = useDawStore.getState().playheadSeekRevision;
      render(<MountedTimeline />);
      act(() => raf.fire(0));
      el.scrollLeft = 750;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      expect(useDawStore.getState().scrollLeft).toBe(550);
      act(() =>
        useRecordHostStore
          .getState()
          .setSnapshot(
            state === null
              ? null
              : recordSnapshot({ state, server_time_ns: 2 }),
          ),
      );
      expect(timelineViewportRegistry.getVisualPan()).toBeNull();
      expect(useDawStore.getState().scrollLeft).toBe(0);
      expect(el.scrollLeft).toBe(200);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
    },
  );

  it("keeps a deliberate scrub from preview back into saved media at the chosen position", () => {
    useRecordHostStore
      .getState()
      .setSnapshot(recordSnapshot({ state: "paused" }));
    useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
    const revision = useDawStore.getState().playheadSeekRevision;
    render(<MountedTimeline />);
    act(() => raf.fire(0));
    el.scrollLeft = 750;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().scrollLeft).toBe(550);
    el.scrollLeft = 600;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(timelineViewportRegistry.getVisualPan()).toBeNull();
    expect(useDawStore.getState().scrollLeft).toBe(400);
    expect(el.scrollLeft).toBe(600);
    expect(useDawStore.getState().playheadSec).toBe(40);
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision + 1);
  });

  it("keeps deliberate subpixel scrubbing distinct from layout projection", () => {
    useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
    const revision = useDawStore.getState().playheadSeekRevision;
    render(<MountedTimeline />);
    act(() => raf.fire(0));
    el.scrollLeft = 305;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().playheadSec).toBe(20.5);
    el.scrollLeft = 305.25;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(useDawStore.getState().scrollLeft).toBe(105.25);
    expect(useDawStore.getState().playheadSec).toBe(20.525);
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision + 2);
    expect(timelineViewportRegistry.getLayoutProjection()).toBeNull();
  });

  it.each(["recording", "paused"] as const)(
    "recenters a cold %s snapshot whose visible line is inside saved media",
    (state) => {
      useRecordHostStore.getState().setSnapshot(recordSnapshot({ state }));
      useDawStore.setState({ playheadSec: 20, scrollLeft: 300 });
      const revision = useDawStore.getState().playheadSeekRevision;
      render(<MountedTimeline />);
      expect(useDawStore.getState().scrollLeft).toBe(0);
      expect(el.scrollLeft).toBe(200);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
    },
  );

  it.each(["recording", "paused"] as const)(
    "preserves a %s visual pan through a viewport resize until an explicit seek",
    (state) => {
      useRecordHostStore.getState().setSnapshot(recordSnapshot({ state }));
      useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
      const revision = useDawStore.getState().playheadSeekRevision;
      const view = render(<MountedTimeline />);
      act(() => raf.fire(0));
      el.scrollLeft = 750;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      expect(useDawStore.getState().scrollLeft).toBe(550);

      view.rerender(<MountedTimeline timeViewportPx={420} />);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
      expect(useDawStore.getState().scrollLeft).toBe(550);
      expect(el.scrollLeft).toBe(760);

      act(() => useDawStore.getState().setPlayheadSec(20));
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision + 1);
      expect(useDawStore.getState().scrollLeft).toBe(0);
      expect(el.scrollLeft).toBe(210);
    },
  );

  it.each(["recording", "paused"] as const)(
    "restores a %s visual pan after tab unmount and same-project refresh",
    (state) => {
      useRecordHostStore.getState().setSnapshot(recordSnapshot({ state }));
      useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
      const revision = useDawStore.getState().playheadSeekRevision;
      const view = render(<MountedTimeline />);
      act(() => raf.fire(0));
      el.scrollLeft = 750;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      expect(useDawStore.getState().scrollLeft).toBe(550);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);

      view.unmount();
      act(() => {
        useDawStore
          .getState()
          .hydrate("/tmp/scroll-hook.json", minimalProject());
      });
      expect(useDawStore.getState().scrollLeft).toBe(550);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
      el.scrollLeft = 0;
      const returned = render(<MountedTimeline timeViewportPx={0} />);
      returned.rerender(<MountedTimeline timeViewportPx={400} />);
      expect.soft(useDawStore.getState().scrollLeft).toBe(550);
      expect.soft(el.scrollLeft).toBe(750);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);

      act(() => useDawStore.getState().setPlayheadSec(20));
      expect(useDawStore.getState().scrollLeft).toBe(0);
      expect(el.scrollLeft).toBe(200);
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision + 1);
    },
  );

  it.each(["project round trip", "Fit"] as const)(
    "recovers from a visual pan after %s while the timeline is unmounted",
    (action) => {
      useRecordHostStore
        .getState()
        .setSnapshot(recordSnapshot({ state: "paused" }));
      useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
      const view = render(<MountedTimeline />);
      act(() => raf.fire(0));
      el.scrollLeft = 750;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
      expect(useDawStore.getState().scrollLeft).toBe(550);
      expect(useDawStore.getState().playheadSec).toBe(20);
      view.unmount();
      act(() => {
        if (action === "project round trip") {
          useDawStore
            .getState()
            .hydrate("/tmp/another-scroll-hook.json", minimalProject());
          expect(useDawStore.getState().playheadSec).toBe(0);
          useDawStore
            .getState()
            .hydrate("/tmp/scroll-hook.json", minimalProject());
          useDawStore.getState().setPlayheadSec(20, "playback");
        } else {
          useDawStore.getState().fitToWindow(400);
        }
      });
      el.scrollLeft = 0;
      const returned = render(<MountedTimeline timeViewportPx={0} />);
      returned.rerender(<MountedTimeline timeViewportPx={400} />);
      expect(useDawStore.getState().scrollLeft).toBe(0);
      expect(el.scrollLeft).toBe(200);
      expect(useDawStore.getState().playheadSec).toBe(20);

      const revision = useDawStore.getState().playheadSeekRevision;
      act(() => useDawStore.getState().setPlayheadSec(40));
      const recoveredScroll = action === "project round trip" ? 200 : 0;
      expect(useDawStore.getState().scrollLeft).toBe(recoveredScroll);
      expect(el.scrollLeft).toBe(recoveredScroll + 200);
      expect(useDawStore.getState().playheadSec).toBe(40);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision + 1);
    },
  );

  describe.each(["recording", "paused", "inactive"] as const)(
    "%s saved-end pan boundary",
    (state) => {
      it.each([
        { logicalLeft: 499, savedTime: 59.9, beyondSavedEnd: false },
        { logicalLeft: 500, savedTime: 60, beyondSavedEnd: false },
        { logicalLeft: 501, savedTime: 60, beyondSavedEnd: true },
        { logicalLeft: 550, savedTime: 60, beyondSavedEnd: true },
      ])("keeps the intended time and view at $logicalLeft px", (pan) => {
        useRecordHostStore
          .getState()
          .setSnapshot(state === "inactive" ? null : recordSnapshot({ state }));
        useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
        const view = render(<MountedTimeline />);
        act(() => raf.fire(0));
        const revision = useDawStore.getState().playheadSeekRevision;
        const visualOnly = state !== "inactive" && pan.beyondSavedEnd;
        const expectedTime = visualOnly ? 20 : pan.savedTime;
        const expectedRevision = revision + (visualOnly ? 0 : 1);
        el.scrollLeft = pan.logicalLeft + 200;
        act(() => {
          el.dispatchEvent(new Event("scroll"));
        });
        expect(useDawStore.getState().playheadSec).toBeCloseTo(expectedTime);
        expect(useDawStore.getState().playheadSeekRevision).toBe(
          expectedRevision,
        );
        expect(useDawStore.getState().scrollLeft).toBe(pan.logicalLeft);
        expect(el.scrollLeft).toBe(pan.logicalLeft + 200);

        act(() => {
          const project = useDawStore.getState().project;
          if (!project) throw new Error("Expected the hydrated project");
          useDawStore.setState({
            project: {
              ...project,
              meta: { ...project.meta, name: "Renamed episode" },
            },
          });
          view.rerender(<MountedTimeline />);
        });
        expect(useDawStore.getState().playheadSec).toBeCloseTo(expectedTime);
        expect(useDawStore.getState().playheadSeekRevision).toBe(
          expectedRevision,
        );
        expect(useDawStore.getState().scrollLeft).toBe(pan.logicalLeft);
        expect(el.scrollLeft).toBe(pan.logicalLeft + 200);

        act(() => useDawStore.getState().setPlayheadSec(expectedTime));
        expect(useDawStore.getState().playheadSeekRevision).toBe(
          expectedRevision + 1,
        );
        expect(useDawStore.getState().playheadSec).toBeCloseTo(expectedTime);
        const recoveredScroll = visualOnly ? 0 : expectedTime * 10 - 200;
        expect(useDawStore.getState().scrollLeft).toBeCloseTo(recoveredScroll);
        expect(el.scrollLeft).toBeCloseTo(recoveredScroll + 200);
      });
    },
  );

  it("publishes corrected pointer-zoom time at the first layout boundary", () => {
    const samples: { time: number; scroll: number; revision: number }[] = [];
    function ZoomObserver() {
      const zoom = useDawStore((s) => s.zoomPxPerSec);
      useLayoutEffect(() => {
        if (zoom !== 20) return;
        const state = useDawStore.getState();
        samples.push({
          time: state.playheadSec,
          scroll: state.scrollLeft,
          revision: state.playheadSeekRevision,
        });
      }, [zoom]);
      return null;
    }
    useDawStore.setState({ playheadSec: 15 });
    Object.defineProperty(el, "clientWidth", { value: 400 });
    timelineViewportRegistry.setTimelineElement(el);
    const revision = useDawStore.getState().playheadSeekRevision;
    const view = render(
      <MountedTimeline>
        <ZoomObserver />
      </MountedTimeline>,
    );
    act(() => useDawStore.getState().applyAnchoredZoom(20, 250));
    expect.soft(samples[0]).toEqual({
      time: 20,
      scroll: 250,
      revision: revision + 1,
    });
    expect(useDawStore.getState().playheadSec).toBe(20);
    expect(useDawStore.getState().scrollLeft).toBe(250);
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision + 1);
    expect(el.scrollLeft).toBe(450);
    expect((250 + useDawStore.getState().scrollLeft) / 20).toBe(25);
    expect(
      view.container
        .querySelector<HTMLElement>(".playhead--fixed")
        ?.style.getPropertyValue("--timeline-fixed-line"),
    ).toBe("150px");
  });

  describe.each(["recording", "paused"] as const)(
    "%s preview-pan pointer zoom",
    (state) => {
      it.each([
        { zoom: 20, anchoredScroll: 1200, recoveredScroll: 200 },
        { zoom: 5, anchoredScroll: 150, recoveredScroll: 0 },
      ])(
        "retains saved time through zoom to $zoom until a seek",
        (geometry) => {
          useRecordHostStore.getState().setSnapshot(recordSnapshot({ state }));
          useDawStore.setState({ playheadSec: 20, scrollLeft: 100 });
          Object.defineProperty(el, "clientWidth", { value: 400 });
          timelineViewportRegistry.setTimelineElement(el);
          const revision = useDawStore.getState().playheadSeekRevision;
          const view = render(<MountedTimeline />);
          act(() => raf.fire(0));
          el.scrollLeft = 750;
          act(() => {
            el.dispatchEvent(new Event("scroll"));
          });
          expect(useDawStore.getState().scrollLeft).toBe(550);
          expect(useDawStore.getState().playheadSec).toBe(20);
          expect(useDawStore.getState().playheadSeekRevision).toBe(revision);

          act(() =>
            useDawStore.getState().applyAnchoredZoom(geometry.zoom, 250),
          );
          view.rerender(<MountedTimeline />);
          expect(useDawStore.getState().scrollLeft).toBe(
            geometry.anchoredScroll,
          );
          expect(el.scrollLeft).toBe(geometry.anchoredScroll + 200);
          expect(useDawStore.getState().playheadSec).toBe(20);
          expect(useDawStore.getState().playheadSeekRevision).toBe(revision);

          act(() => useDawStore.getState().setPlayheadSec(20));
          expect(useDawStore.getState().playheadSec).toBe(20);
          expect(useDawStore.getState().playheadSeekRevision).toBe(
            revision + 1,
          );
          expect(useDawStore.getState().scrollLeft).toBe(
            geometry.recoveredScroll,
          );
          expect(el.scrollLeft).toBe(geometry.recoveredScroll + 200);
        },
      );
    },
  );

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
    // The playhead sits at the left edge (time 0 beside the headers), so the
    // scroll to logical 50 moves it 50 px of time, 5 s.
    expect(useDawStore.getState().playheadSec).toBe(5);
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
    // Playhead 100 px in, scrolled 50 px on; the hook input still says 10 px/s.
    expect(useDawStore.getState().playheadSec).toBe(5);
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
    expect(el.scrollLeft).toBe(200);
    expect(useDawStore.getState().scrollLeft).toBe(0);
  });
});
