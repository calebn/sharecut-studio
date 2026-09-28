import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetServerClock,
  setServerClockOffsetForTests,
} from "../presence/clock";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { PresenceOverlay } from "./PresenceOverlay";
import { TimelineMetricsProvider } from "./timelineMetrics";

const hostTracks = [
  {
    id: "host",
    label: "Host",
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 60,
    fx_count: 0,
    stem_is_fresh: true,
  },
  {
    id: "guest",
    label: "Guest",
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 60,
    fx_count: 0,
    stem_is_fresh: true,
  },
];

describe("PresenceOverlay", () => {
  afterEach(() => {
    useDawStore.setState({
      localClientId: null,
      sessionClients: [],
      statusAnnouncement: "",
    });
    resetServerClock();
  });

  it("reads the session roster and local id from the store", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      localClientId: "me",
      sessionClients: [
        { client_id: "me", role: "viewer", playhead_sec: 1 },
        {
          client_id: "them",
          role: "viewer",
          playhead_sec: 2,
          last_seen_ns: Date.now() * 1e6,
          meta: { display_name: "Ada" },
        },
      ],
    });
    const { container } = render(
      <PresenceOverlay
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={{}}
      />,
    );
    const playheads = container.querySelectorAll(".presence-playhead");
    expect(playheads).toHaveLength(1);
    expect((playheads[0] as HTMLElement).style.left).toBe("20px");
    act(() => useDawStore.setState({ sessionClients: [] }));
    expect(container.querySelector(".presence-overlay")).toBeNull();
  });

  it("announces a joined and a departed client by display name", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ localClientId: "me", sessionClients: [] });
    const { rerender } = render(
      <PresenceOverlay
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={{}}
      />,
    );
    act(() => {
      useDawStore.setState({
        sessionClients: [
          {
            client_id: "bea",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Bea" },
          },
        ],
      });
    });
    rerender(
      <PresenceOverlay
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={{}}
      />,
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("Bea joined");

    act(() => {
      useDawStore.setState({ sessionClients: [] });
    });
    rerender(
      <PresenceOverlay
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={{}}
      />,
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("Someone left");
  });

  it("announces nothing when a present client only moves", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const bea = {
      client_id: "bea",
      role: "viewer",
      playhead_sec: 1,
      last_seen_ns: Date.now() * 1e6,
      meta: { display_name: "Bea" },
    };
    useDawStore.setState({ localClientId: "me", sessionClients: [bea] });
    render(
      <PresenceOverlay
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={{}}
      />,
    );
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    try {
      act(() => {
        useDawStore.setState({
          sessionClients: [{ ...bea, playhead_sec: 4 }],
        });
      });
      expect(announce).not.toHaveBeenCalled();
    } finally {
      announce.mockRestore();
    }
  });

  it("places a lane_pos: 1 cursor at top 100px with a TimelineMetricsProvider laneHeight of 100", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      localClientId: "me",
      sessionClients: [
        { client_id: "me", role: "viewer" },
        {
          client_id: "them",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: { display_name: "Ada", cursor: { t_sec: 1, lane_pos: 1 } },
        },
      ],
    });
    const { container } = render(
      <TimelineMetricsProvider
        value={{ laneHeight: 100, markerLaneHeight: 24 }}
      >
        <PresenceOverlay
          zoomPxPerSec={10}
          height={200}
          tracks={hostTracks}
          clipsByTrack={{}}
        />
      </TimelineMetricsProvider>,
    );
    const cursor = container.querySelector(".presence-cursor") as HTMLElement;
    expect(cursor.style.top).toBe("100px");
  });

  it("treats a just-seen client as stale when the server clock offset makes it look old", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    setServerClockOffsetForTests(60_000);
    useDawStore.setState({
      localClientId: "me",
      sessionClients: [
        { client_id: "me", role: "viewer" },
        {
          client_id: "them",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: { display_name: "Ada" },
        },
      ],
    });
    const { container } = render(
      <PresenceOverlay
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={{}}
      />,
    );
    expect(container.querySelector(".presence-overlay")).toBeNull();
  });

  it("drops and announces a client that stops heartbeating with no other store change", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    try {
      useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
      useDawStore.setState({
        localClientId: "me",
        sessionClients: [
          { client_id: "me", role: "viewer" },
          {
            client_id: "them",
            role: "viewer",
            playhead_sec: 2,
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Ada" },
          },
        ],
      });
      const { container } = render(
        <PresenceOverlay
          zoomPxPerSec={10}
          height={72}
          tracks={hostTracks}
          clipsByTrack={{}}
        />,
      );
      expect(container.querySelector(".presence-overlay")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(35_000);
      });
      expect(container.querySelector(".presence-overlay")).toBeNull();
      expect(useDawStore.getState().statusAnnouncement).toBe("Someone left");
      const tickIds = setIntervalSpy.mock.calls.flatMap((call, i) =>
        call[1] === 5_000 ? [setIntervalSpy.mock.results[i]!.value] : [],
      );
      expect(tickIds.length).toBeGreaterThan(0);
      for (const id of tickIds) {
        expect(clearIntervalSpy).toHaveBeenCalledWith(id);
      }
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("runs no staleness tick while there is no local client id", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    try {
      useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
      useDawStore.setState({
        localClientId: null,
        sessionClients: [
          {
            client_id: "them",
            role: "viewer",
            playhead_sec: 2,
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Ada" },
          },
        ],
      });
      render(
        <PresenceOverlay
          zoomPxPerSec={10}
          height={72}
          tracks={hostTracks}
          clipsByTrack={{}}
        />,
      );
      expect(setIntervalSpy.mock.calls.some((call) => call[1] === 5_000)).toBe(
        false,
      );
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
