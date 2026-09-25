import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { presenceCursorFromPointer } from "../presence/usePresenceCursorSource";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { PresenceOverlay, PresenceOverlayView } from "./PresenceOverlay";
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

describe("PresenceOverlayView", () => {
  it("positions ghosts from zoom and hides the local client", async () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const project = minimalProject();
    const { container } = render(
      <PresenceOverlayView
        clients={[
          {
            client_id: "me",
            role: "viewer",
            meta: { cursor: { t_sec: 1, track_id: "host" } },
          },
          {
            client_id: "them",
            role: "viewer",
            playhead_sec: 2,
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              color_index: 2,
              cursor: { t_sec: 3, track_id: "host" },
              transport: { playing: false, playhead_sec: 2, rate: 1 },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    expect(
      container.querySelector(".presence-overlay")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).not.toContain("me");
    const playhead = container.querySelector(
      ".presence-playhead",
    ) as HTMLElement;
    expect(playhead.style.left).toBe("20px");
    await expectNoA11yViolations(container);
  });

  it("omits the followed client playhead when asked", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const project = minimalProject();
    const { container } = render(
      <PresenceOverlayView
        clients={[
          {
            client_id: "me",
            role: "viewer",
          },
          {
            client_id: "them",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              transport: { playing: false, playhead_sec: 2, rate: 1 },
              cursor: { t_sec: 3, track_id: "host" },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
        hidePlayheadForClientId="them"
      />,
    );
    expect(container.querySelector(".presence-overlay")).toBeTruthy();
    expect(container.querySelector(".presence-playhead")).toBeNull();
    expect(container.querySelector(".presence-cursor")).toBeTruthy();
  });

  it("omits playhead ghosts for clients who are following someone", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const project = minimalProject();
    const { container } = render(
      <PresenceOverlayView
        clients={[
          { client_id: "me", role: "viewer" },
          {
            client_id: "follower",
            role: "viewer",
            playhead_sec: 4,
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Guest",
              following: "me",
              transport: { playing: true, playhead_sec: 4, rate: 1 },
              cursor: { t_sec: 5, track_id: "host" },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    expect(container.querySelector(".presence-playhead")).toBeNull();
    expect(container.querySelector(".presence-cursor")).toBeTruthy();
  });

  it("draws no ghosts until local client id is known", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const project = minimalProject();
    const { container } = render(
      <PresenceOverlayView
        clients={[
          {
            client_id: "guest-token-me",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Me",
              cursor: { t_sec: 1, track_id: "host" },
            },
          },
        ]}
        localClientId={null}
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    expect(container.querySelector(".presence-cursor")).toBeNull();
    expect(container.textContent).not.toContain("Me");
  });

  it("places a cursor from lane_pos without guessing", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const project = minimalProject();
    const { container } = render(
      <PresenceOverlayView
        clients={[
          { client_id: "me", role: "viewer" },
          {
            client_id: "them",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              cursor: { t_sec: 3, lane_pos: 1.4 },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={144}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    const el = container.querySelector(".presence-cursor") as HTMLElement;
    expect(el.style.top).toBe(`${1.4 * 72}px`);
  });

  it("does not draw a timeline cursor for an unresolved track", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const project = minimalProject();
    const { container } = render(
      <PresenceOverlayView
        clients={[
          { client_id: "me", role: "viewer" },
          {
            client_id: "them",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              cursor: { t_sec: 3, track_id: "missing" },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    expect(container.querySelector(".presence-cursor")).toBeNull();
  });

  it("draws a transcript-word selection box", () => {
    const project = minimalProject({
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 1,
            end: 2,
            text: "hello",
            timeline_start: 1,
            timeline_end: 2,
            words: [
              {
                text: "hello",
                start: 1,
                end: 1.4,
                timeline_start: 1,
                timeline_end: 1.4,
                word_index: 0,
              },
            ],
          },
        ],
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    const { container } = render(
      <PresenceOverlayView
        clients={[
          { client_id: "me", role: "viewer" },
          {
            client_id: "them",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              selection: {
                kind: "transcriptWord",
                track_id: "host",
                word_index: 0,
              },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    const box = container.querySelector(".presence-selection") as HTMLElement;
    expect(box).toBeTruthy();
    expect(parseFloat(box.style.left)).toBeCloseTo(10, 5);
    expect(parseFloat(box.style.width)).toBeCloseTo(4, 5);
  });

  it("draws a ghost box for an envelopePoint selection", () => {
    const project = minimalProject({
      tracks: hostTracks,
      envelopes: [
        {
          track_id: "host",
          parameter: "volume",
          points: [
            { id: "early", time: 0, value: 1 },
            { id: "late", time: 4, value: 0.5 },
          ],
        },
      ],
    });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    const { container } = render(
      <PresenceOverlayView
        clients={[
          { client_id: "me", role: "viewer" },
          {
            client_id: "them",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              selection: {
                kind: "envelopePoint",
                track_id: "host",
                time: 4,
              },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    const box = container.querySelector(".presence-selection") as HTMLElement;
    expect(box).toBeTruthy();
    expect(parseFloat(box.style.left)).toBeCloseTo(40, 5);
    // A point: a fixed 5 px box, whatever the zoom.
    expect(parseFloat(box.style.width)).toBeCloseTo(5, 5);
  });

  it("keeps a remote point selection 2 px wide at any zoom", () => {
    const project = minimalProject({ tracks: hostTracks });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    const clients = [
      { client_id: "me", role: "viewer" },
      {
        client_id: "them",
        role: "viewer",
        last_seen_ns: Date.now() * 1e6,
        meta: {
          display_name: "Ada",
          selection: { kind: "pending", track_id: "host", time: 2 },
        },
      },
    ];
    const view = (zoom: number) => (
      <PresenceOverlayView
        clients={clients}
        localClientId="me"
        zoomPxPerSec={zoom}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />
    );
    const { container, rerender } = render(view(10));
    const box = () =>
      container.querySelector(".presence-selection") as HTMLElement;
    expect(parseFloat(box().style.width)).toBeCloseTo(2, 5);
    rerender(view(48000));
    expect(parseFloat(box().style.left)).toBeCloseTo(96000, 5);
    expect(parseFloat(box().style.width)).toBeCloseTo(2, 5);
  });

  it("does not draw a timeline cursor for an anchor-only pointer", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const project = minimalProject();
    const { container } = render(
      <PresenceOverlayView
        clients={[
          { client_id: "me", role: "viewer" },
          {
            client_id: "them",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              cursor: { anchor: "track:host:mute", x: 0.5, y: 0.5 },
            },
          },
        ]}
        localClientId="me"
        zoomPxPerSec={10}
        height={72}
        tracks={hostTracks}
        clipsByTrack={project.clips.tracks}
      />,
    );
    expect(container.querySelector(".presence-cursor")).toBeNull();
  });

  it.each([
    [150, 72],
    [72, 240],
  ])(
    "round-trips lane_pos from %ipx lanes to %ipx lanes",
    (senderLane, viewerLane) => {
      // Sender: pointer 60% down the second lane of its own stack.
      const lanes = document.createElement("div");
      Object.defineProperty(lanes, "getBoundingClientRect", {
        value: () => ({
          left: 0,
          top: 100,
          width: 400,
          height: 2 * senderLane,
        }),
      });
      const row = document.createElement("div");
      row.className = "lane-row";
      row.dataset.trackId = "guest";
      Object.defineProperty(row, "getBoundingClientRect", {
        value: () => ({ height: senderLane }),
      });
      const cursor = presenceCursorFromPointer(
        row,
        40,
        100 + 1.6 * senderLane,
        lanes,
        0,
        10,
        60,
      );
      expect(cursor?.lane_pos).toBeCloseTo(1.6, 3);

      // Viewer: same spot in the same lane at its own lane height.
      useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
      const project = minimalProject();
      const { container } = render(
        <TimelineMetricsProvider
          value={{ laneHeight: viewerLane, markerLaneHeight: 24 }}
        >
          <PresenceOverlayView
            clients={[
              { client_id: "me", role: "viewer" },
              {
                client_id: "them",
                role: "viewer",
                last_seen_ns: Date.now() * 1e6,
                meta: { display_name: "Ada", cursor: cursor ?? undefined },
              },
            ]}
            localClientId="me"
            zoomPxPerSec={10}
            height={2 * viewerLane}
            tracks={hostTracks}
            clipsByTrack={project.clips.tracks}
          />
        </TimelineMetricsProvider>,
      );
      const el = container.querySelector(".presence-cursor") as HTMLElement;
      expect(parseFloat(el.style.top)).toBeCloseTo(1.6 * viewerLane, 1);
    },
  );
});

describe("PresenceOverlay", () => {
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
    useDawStore.setState({ localClientId: null });
  });
});
