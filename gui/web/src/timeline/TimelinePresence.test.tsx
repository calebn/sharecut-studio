import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetServerClock,
  setServerClockOffsetForTests,
} from "../presence/clock";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import {
  clipRow,
  minimalProject,
  sampleTrack,
  sessionRoster,
} from "../test/fixtures";
import type { SessionClient } from "../types/session";
import { TimelinePresence } from "./TimelinePresence";
import { TimelineRuler } from "./TimelineRuler";

const leafRenders = vi.hoisted(() => vi.fn());

vi.mock("../system/Presence", async () => {
  const actual =
    await vi.importActual<typeof import("../system/Presence")>(
      "../system/Presence",
    );
  const Leaf = memo(function Leaf(
    props: Parameters<typeof actual.Presence>[0],
  ) {
    leafRenders(props);
    return <actual.Presence {...props} />;
  });
  return { ...actual, Presence: Leaf };
});

const NOW = 1_800_000_000_000;

function Host(
  props: Partial<React.ComponentProps<typeof TimelinePresence>> = {},
) {
  return (
    <TimelinePresence
      canvasWidthPx={600}
      viewportPx={300}
      zoomPxPerSec={10}
      laneHeight={80}
      markerLaneHeightPx={48}
      followingClientId={null}
      {...props}
    />
  );
}

const remote = (id: string, over: Partial<SessionClient> = {}) => ({
  client_id: id,
  role: "viewer",
  playhead_sec: 2,
  last_seen_ns: Date.now() * 1e6,
  meta: { display_name: id.toUpperCase() },
  ...over,
});

function seed(clients: SessionClient[]) {
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
      clips: {
        tracks: {
          host: [],
          guest: [
            clipRow({
              id: "c1",
              track_id: "guest",
              timeline_start: 10,
              timeline_end: 15,
            }),
          ],
        },
        clip_count: 1,
      },
    }),
  );
  useDawStore.setState({
    localClientId: "me",
    sessionRosterVersion: 5,
    sessionClients: sessionRoster([
      { client_id: "me", role: "viewer", playhead_sec: 1 },
      ...clients,
    ]),
  });
}

const persons = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>(".sys-presence-person"),
];
const xOf = (el: HTMLElement) => el.style.getPropertyValue("--sys-presence-x");

beforeEach(() => leafRenders.mockClear());

afterEach(() => {
  // Unmount first: a mounted host would announce the roster reset below.
  cleanup();
  useDawStore.setState({
    localClientId: null,
    sessionClients: sessionRoster([]),
    statusAnnouncement: "",
    scrollLeft: 0,
  });
  resetServerClock();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TimelinePresence", () => {
  it("reads the roster and local id, drawing each remote playhead and not the local one", () => {
    seed([remote("bea")]);
    const { container } = render(<Host />);
    const lines = persons(container);
    expect(lines).toHaveLength(1);
    expect(xOf(lines[0]!)).toBe("20px");
    expect(lines[0]!.textContent).toBe("B");
    act(() => useDawStore.setState({ sessionClients: sessionRoster([]) }));
    expect(persons(container)).toHaveLength(0);
    expect(container.querySelector(".sys-presence")).not.toBeNull();
  });

  it("draws nothing for the person you follow, playhead or selection", () => {
    seed([
      remote("bea", { meta: { selection: { kind: "clip", id: "c1" } } }),
      remote("cy"),
    ]);
    const { container, rerender } = render(<Host />);
    expect(persons(container)).toHaveLength(2);
    expect(container.querySelectorAll(".sys-presence-sel")).toHaveLength(1);
    rerender(<Host followingClientId="bea" />);
    expect(persons(container).map((el) => el.dataset.person)).toEqual(["cy"]);
    expect(container.querySelectorAll(".sys-presence-sel")).toHaveLength(0);
  });

  it("draws no playhead for an observer", () => {
    seed([remote("bea", { meta: { following: "cy" } })]);
    const { container } = render(<Host />);
    expect(persons(container)).toHaveLength(0);
  });

  it("places selections by the lane heights and the marker lane height it is given", () => {
    seed([remote("bea", { meta: { selection: { kind: "clip", id: "c1" } } })]);
    const { container, rerender } = render(<Host />);
    const sel = () =>
      container.querySelector<HTMLElement>(".sys-presence-sel")!.style;
    // Ruler 24 + marker lane 48 + one lane of 80 above the guest lane.
    expect(sel().getPropertyValue("--sys-presence-top")).toBe("152px");
    expect(sel().getPropertyValue("--sys-presence-height")).toBe("80px");
    expect(sel().getPropertyValue("--sys-presence-left")).toBe("100px");
    expect(sel().getPropertyValue("--sys-presence-right")).toBe("150px");
    rerender(<Host markerLaneHeightPx={72} laneHeight={96} />);
    expect(sel().getPropertyValue("--sys-presence-top")).toBe("192px");
    expect(sel().getPropertyValue("--sys-presence-height")).toBe("96px");
  });

  it("draws a point selection at its px minimum", () => {
    seed([
      remote("bea", {
        meta: { selection: { kind: "pending", track_id: "host", time: 3 } },
      }),
    ]);
    const { container } = render(<Host />);
    const s = container.querySelector<HTMLElement>(".sys-presence-sel")!.style;
    const w =
      Number.parseFloat(s.getPropertyValue("--sys-presence-right")) -
      Number.parseFloat(s.getPropertyValue("--sys-presence-left"));
    expect(w).toBeCloseTo(2);
  });

  it("sits in the ruler's own window for every scroll, with the leaf's start and width from it", () => {
    seed([remote("bea")]);
    for (const scrollLeft of [0, 299, 300, 650, 9_000]) {
      useDawStore.setState({ scrollLeft });
      const { container, unmount } = render(
        <>
          <TimelineRuler
            canvasWidthPx={9_600}
            viewportPx={300}
            sessionSec={960}
            zoomPxPerSec={10}
            fixedPlayhead={false}
            onSeek={vi.fn()}
            onFit={vi.fn()}
          />
          <Host canvasWidthPx={9_600} />
        </>,
      );
      const rulerWindow = container.querySelector<HTMLElement>(
        ".timeline-ruler-window",
      )!;
      const presenceWindow = container.querySelector<HTMLElement>(
        ".timeline-presence-window",
      )!;
      expect(presenceWindow.style.insetInlineStart).toBe(
        rulerWindow.style.insetInlineStart,
      );
      const left = Number.parseFloat(presenceWindow.style.insetInlineStart);
      const lastProps = leafRenders.mock.lastCall![0];
      expect(lastProps.start).toBeCloseTo(left / 10);
      expect(lastProps.width).toBe(
        Number.parseFloat(presenceWindow.style.inlineSize),
      );
      unmount();
    }
  });

  describe("announcer", () => {
    it("announces a joined and a departed client by display name", () => {
      seed([]);
      const { rerender } = render(<Host />);
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([remote("bea")]),
        });
      });
      rerender(<Host />);
      expect(useDawStore.getState().statusAnnouncement).toBe("BEA joined");
      useDawStore.setState({ statusAnnouncement: "" });
      act(() => {
        useDawStore.setState({ sessionClients: sessionRoster([]) });
      });
      rerender(<Host />);
      expect(useDawStore.getState().statusAnnouncement).toBe("Someone left");
    });

    it("names a joiner by display name", () => {
      seed([]);
      render(<Host />);
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([
            remote("bea", { meta: { display_name: "Bea" } }),
          ]),
        });
      });
      expect(useDawStore.getState().statusAnnouncement).toBe("Bea joined");
    });

    it("announces nothing when a present client only moves", () => {
      seed([remote("bea")]);
      render(<Host />);
      const spy = vi.spyOn(useDawStore.getState(), "announceStatus");
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer" },
            remote("bea", { playhead_sec: 9 }),
          ]),
        });
      });
      expect(spy).not.toHaveBeenCalled();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    });

    it("announces a client already present at mount as nobody joining", () => {
      seed([remote("bea")]);
      render(<Host />);
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    });

    it("drops and announces a client that stops heartbeating with no other store change", () => {
      vi.useFakeTimers({ now: NOW });
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      const clearIntervalSpy = vi.spyOn(window, "clearInterval");
      seed([remote("bea", { last_seen_ns: Date.now() * 1e6 })]);
      const { container } = render(<Host />);
      expect(persons(container)).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(35_000);
      });
      expect(persons(container)).toHaveLength(0);
      expect(useDawStore.getState().statusAnnouncement).toBe("Someone left");
      const tickIds = setIntervalSpy.mock.calls.flatMap((call, i) =>
        call[1] === 5_000 ? [setIntervalSpy.mock.results[i]!.value] : [],
      );
      expect(tickIds.length).toBeGreaterThan(0);
      for (const id of tickIds) {
        expect(clearIntervalSpy).toHaveBeenCalledWith(id);
      }
    });
  });

  it("treats a just-seen client as stale when the server clock offset makes it look old", () => {
    seed([remote("bea")]);
    setServerClockOffsetForTests(60_000);
    const { container } = render(<Host />);
    expect(persons(container)).toHaveLength(0);
  });

  it("runs no staleness tick while there is no local client id", () => {
    vi.useFakeTimers({ now: NOW });
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    seed([remote("bea")]);
    useDawStore.setState({ localClientId: null });
    render(<Host />);
    expect(setIntervalSpy.mock.calls.some((call) => call[1] === 5_000)).toBe(
      false,
    );
  });

  describe("render isolation", () => {
    it("an unrelated store change re-renders neither the leaf nor its people", () => {
      seed([remote("a"), remote("b"), remote("c")]);
      render(<Host />);
      leafRenders.mockClear();
      act(() => {
        useDawStore.setState({ statusAnnouncement: "x" });
      });
      expect(leafRenders).not.toHaveBeenCalled();
    });

    it("a cursor-only change redraws nothing: people and selections keep their arrays", () => {
      seed([remote("a"), remote("b")]);
      render(<Host />);
      const before = leafRenders.mock.lastCall![0];
      leafRenders.mockClear();
      act(() => {
        useDawStore
          .getState()
          .applyPresenceDelta("a", { meta: { cursor: { x: 4, y: 5 } } }, 5);
      });
      expect(leafRenders).not.toHaveBeenCalled();
      expect(leafRenders.mock.calls).toHaveLength(0);
      expect(before.people).toHaveLength(2);
    });

    it("a change of one client's name renders the leaf once and leaves the others' people as they were", () => {
      seed([remote("a"), remote("b")]);
      render(<Host />);
      const before = leafRenders.mock.lastCall![0].people;
      leafRenders.mockClear();
      act(() => {
        useDawStore
          .getState()
          .applyPresenceDelta("a", { meta: { display_name: "A2" } }, 5);
      });
      expect(leafRenders).toHaveBeenCalledTimes(1);
      const after = leafRenders.mock.lastCall![0].people;
      expect(after.find((p: { id: string }) => p.id === "b")).toBe(
        before.find((p: { id: string }) => p.id === "b"),
      );
      expect(after.find((p: { id: string }) => p.id === "a").name).toBe("A2");
    });

    it("a project edit that no selection reads re-renders nothing", () => {
      seed([remote("a", { meta: { selection: { kind: "clip", id: "c1" } } })]);
      render(<Host />);
      const first = leafRenders.mock.lastCall![0];
      leafRenders.mockClear();
      act(() => {
        const project = useDawStore.getState().project!;
        useDawStore.setState({ project: { ...project, chapters: [] } });
      });
      expect(leafRenders).not.toHaveBeenCalled();
      expect(first.selections).toHaveLength(1);
      // A rebuild that finds the same selection draws nothing new.
      act(() => {
        const project = useDawStore.getState().project!;
        useDawStore.setState({
          project: {
            ...project,
            clips: { ...project.clips, tracks: { ...project.clips.tracks } },
          },
        });
      });
      expect(leafRenders).not.toHaveBeenCalled();
      // Moving the selected clip does.
      act(() => {
        const project = useDawStore.getState().project!;
        useDawStore.setState({
          project: {
            ...project,
            clips: {
              ...project.clips,
              tracks: {
                ...project.clips.tracks,
                guest: [
                  clipRow({
                    id: "c1",
                    track_id: "guest",
                    timeline_start: 20,
                    timeline_end: 25,
                  }),
                ],
              },
            },
          },
        });
      });
      expect(leafRenders).toHaveBeenCalledTimes(1);
      expect(leafRenders.mock.lastCall![0].selections).not.toBe(
        first.selections,
      );
    });

    it("a zoom change keeps the rows and the selections that did not move", () => {
      seed([remote("a", { meta: { selection: { kind: "clip", id: "c1" } } })]);
      const { rerender } = render(<Host />);
      const first = leafRenders.mock.lastCall![0];
      rerender(<Host zoomPxPerSec={20} />);
      const second = leafRenders.mock.lastCall![0];
      expect(second.rows).toBe(first.rows);
      expect(second.selections).toBe(first.selections);
      expect(second.pxPerSecond).toBe(20);
    });
  });

  describe("playing playhead", () => {
    let frames: Map<number, FrameRequestCallback>;
    let nextId: number;
    let cancel: ReturnType<typeof vi.fn>;
    const flush = () => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(0);
    };

    beforeEach(() => {
      vi.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setInterval", "clearInterval"],
      });
      frames = new Map();
      nextId = 0;
      cancel = vi.fn((id: number) => {
        frames.delete(id);
      });
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((cb: FrameRequestCallback) => {
          nextId += 1;
          frames.set(nextId, cb);
          return nextId;
        }),
      );
      vi.stubGlobal("cancelAnimationFrame", cancel);
    });
    afterEach(() => vi.unstubAllGlobals());

    const playing = (id = "bea", over: Partial<SessionClient> = {}) =>
      remote(id, {
        last_seen_ns: NOW * 1e6,
        meta: {
          display_name: id,
          transport: {
            playing: true,
            playhead_sec: 2,
            rate: 1,
            stamped_ns: NOW * 1e6,
          },
        },
        ...over,
      });

    it("runs no frame while nobody plays", () => {
      seed([remote("bea")]);
      render(<Host />);
      expect(frames.size).toBe(0);
      expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it("moves the line by whole px as the server clock advances, and renders only when a px changes", () => {
      seed([playing()]);
      const { container } = render(<Host />);
      expect(xOf(persons(container)[0]!)).toBe("20px");
      leafRenders.mockClear();
      // 10 ms at 10 px/s is a hundredth of a px: no new px, no render.
      vi.setSystemTime(NOW + 10);
      act(flush);
      expect(leafRenders).not.toHaveBeenCalled();
      vi.setSystemTime(NOW + 1_000);
      act(flush);
      expect(xOf(persons(container)[0]!)).toBe("30px");
      expect(leafRenders).toHaveBeenCalledTimes(1);
      vi.setSystemTime(NOW + 2_000);
      act(flush);
      expect(xOf(persons(container)[0]!)).toBe("40px");
    });

    it("ticks no one who is followed or following, and stops when the last player stops", () => {
      seed([playing("bea"), playing("cy", { meta: { following: "bea" } })]);
      const { rerender } = render(<Host followingClientId="bea" />);
      expect(frames.size).toBe(0);
      rerender(<Host />);
      expect(frames.size).toBe(1);
      act(() => {
        useDawStore.setState({
          sessionClients: sessionRoster([
            { client_id: "me", role: "viewer" },
            remote("bea"),
          ]),
        });
      });
      expect(cancel).toHaveBeenCalled();
      expect(frames.size).toBe(0);
    });

    it("cancels its frame on unmount", () => {
      seed([playing()]);
      const { unmount } = render(<Host />);
      expect(frames.size).toBe(1);
      unmount();
      expect(frames.size).toBe(0);
      expect(cancel).toHaveBeenCalled();
    });
  });

  it("has no axe violations", async () => {
    seed([remote("bea", { meta: { selection: { kind: "clip", id: "c1" } } })]);
    const { container } = render(<Host />);
    await expectNoA11yViolations(container);
  });
});
