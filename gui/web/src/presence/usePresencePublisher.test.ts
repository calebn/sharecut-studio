import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindPlaybackClock } from "../audio/playbackClock";
import { useFollowUi } from "../hooks/useFollowUi";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sessionRoster } from "../test/fixtures";
import { setPresenceCursor, setPresenceCursorSink } from "./followSync";
import { usePresencePublisher } from "./usePresencePublisher";

function lastUi(sent: Record<string, unknown>[]): Record<string, unknown> {
  const frames = sent.filter((f) => (f.meta as { ui?: unknown }).ui != null);
  expect(frames.length).toBeGreaterThan(0);
  return (frames[frames.length - 1].meta as { ui: Record<string, unknown> }).ui;
}

describe("usePresencePublisher", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
  });
  afterEach(() => {
    setPresenceCursorSink(null);
    vi.useRealTimers();
  });

  it("omits copied playhead and viewport while following", () => {
    useDawStore.setState({
      followingClientId: "host",
      playheadSec: 12,
      isPlaying: true,
    });
    const sent: Record<string, unknown>[] = [];
    renderHook(() =>
      usePresencePublisher((frame) => sent.push(frame), "Guest"),
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.some((f) => (f.meta as { following?: string }).following === "host"),
    ).toBe(true);
    for (const frame of sent) {
      expect(frame).not.toHaveProperty("playhead_sec");
      const meta = frame.meta as {
        transport?: { playhead_sec?: number } | null;
        viewport?: unknown;
      };
      expect(
        meta.transport == null || meta.transport.playhead_sec == null,
      ).toBe(true);
      expect(meta.viewport == null).toBe(true);
    }
  });

  it("publishes a padded fixed-playhead viewport from 0 (#385)", () => {
    // Scrolled 15 s before the start; no measured viewport, so a 60 s span.
    useDawStore.setState({
      followingClientId: null,
      scrollLeft: -150,
      zoomPxPerSec: 10,
    });
    const sent: Record<string, unknown>[] = [];
    renderHook(() =>
      usePresencePublisher((frame) => sent.push(frame), "Guest"),
    );
    const viewports = sent
      .map((f) => (f.meta as { viewport?: unknown }).viewport)
      .filter(Boolean) as { start_sec: number; end_sec: number }[];
    expect(viewports.length).toBeGreaterThan(0);
    // Shifted to 0, not shrunk: followers keep the same zoom.
    expect(viewports.at(-1)).toEqual({ start_sec: 0, end_sec: 60 });
  });

  it("still publishes ui while following", () => {
    useDawStore.setState({
      followingClientId: "host",
      activeTab: "comments",
      auditionMode: "fx",
      viewerMute: { host: true, guest: false },
      soloTracks: { guest: true },
    });
    const sent: Record<string, unknown>[] = [];
    renderHook(() =>
      usePresencePublisher((frame) => sent.push(frame), "Guest"),
    );
    const withUi = sent.find((f) => {
      const meta = f.meta as { ui?: { tab?: string; viewer_mute?: string[] } };
      return meta.ui != null;
    });
    expect(withUi).toBeTruthy();
    const ui = (withUi!.meta as { ui: Record<string, unknown> }).ui;
    expect(ui.tab).toBe("comments");
    expect(ui.audition).toBe("fx");
    expect(ui.viewer_mute).toEqual(["host"]);
    expect(ui.solo).toEqual(["guest"]);
    for (const frame of sent) {
      const meta = frame.meta as { transport?: unknown };
      expect(meta.transport == null).toBe(true);
    }
  });

  it("does not let a disconnected publisher steal the cursor sink", () => {
    const hostSent: Record<string, unknown>[] = [];
    renderHook(() => {
      usePresencePublisher((frame) => hostSent.push(frame), "Host");
      usePresencePublisher(null, "Guest");
    });
    const before = hostSent.length;
    setPresenceCursor({ anchor: "track:guest:mute", x: 0.5, y: 0.5 });
    const added = hostSent.slice(before);
    expect(
      added.some((f) => {
        const meta = f.meta as { cursor?: { anchor?: string } };
        return meta.cursor?.anchor === "track:guest:mute";
      }),
    ).toBe(true);
  });

  it("maps a touch desktop tab to a phone mode that followers apply", () => {
    useDawStore.setState({
      followingClientId: null,
      pointerKind: "coarse",
      activeTab: "transcript",
      mobileMode: "listen",
      shellBreakpoint: "desktop",
    });
    const sent: Record<string, unknown>[] = [];
    renderHook(() =>
      usePresencePublisher((frame) => sent.push(frame), "Guest"),
    );
    const ui = lastUi(sent);
    expect(ui.mobile_mode).toBe("text");

    useDawStore.setState({
      shellBreakpoint: "phone",
      followingClientId: "leader",
      activeTab: "comments",
      mobileMode: "listen",
      sessionClients: sessionRoster([
        {
          client_id: "leader",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: { ui },
        },
      ]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().mobileMode).toBe("text");
  });

  it.each(["listen", "timeline"] as const)(
    "keeps phone %s mode for a mouse leader and follower",
    (mode) => {
      useDawStore.setState({
        followingClientId: null,
        pointerKind: "fine",
        mobileMode: mode,
        shellBreakpoint: "phone",
      });
      const sent: Record<string, unknown>[] = [];
      renderHook(() =>
        usePresencePublisher((frame) => sent.push(frame), "Guest"),
      );
      const ui = lastUi(sent);
      expect(ui.mobile_mode).toBe(mode);

      useDawStore.setState({
        followingClientId: "leader",
        activeTab: "comments",
        mobileMode: "text",
        sessionClients: sessionRoster([
          {
            client_id: "leader",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { ui },
          },
        ]),
      });
      renderHook(() => useFollowUi());
      expect(useDawStore.getState().mobileMode).toBe(mode);
    },
  );

  it("publishes store changes without re-rendering its host", async () => {
    useDawStore.setState({
      followingClientId: null,
      isPlaying: false,
      playheadSec: 0,
      selection: null,
      activeTab: "transcript",
    });
    const sent: Record<string, unknown>[] = [];
    let renders = 0;
    renderHook(() => {
      renders += 1;
      usePresencePublisher((frame) => sent.push(frame), "Host");
    });
    const rendersAfterMount = renders;
    act(() => {
      useDawStore.setState({ isPlaying: true, playheadSec: 4 });
      useDawStore.setState({ playheadSec: 5 });
      useDawStore.setState({ scrollLeft: 120 });
      useDawStore.setState({ activeTab: "comments" });
    });
    expect(renders).toBe(rendersAfterMount);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    const metas = sent.map((f) => f.meta as Record<string, unknown>);
    expect(
      metas.some(
        (m) =>
          (m.transport as { playing?: boolean } | undefined)?.playing === true,
      ),
    ).toBe(true);
    expect(
      metas.some(
        (m) => (m.ui as { tab?: string } | undefined)?.tab === "comments",
      ),
    ).toBe(true);
    const last = metas.findLast((m) => m.transport != null) as {
      transport: { playhead_sec: number };
    };
    expect(last.transport.playhead_sec).toBe(5);
  });

  it("publishes a playback rate change while paused", async () => {
    useDawStore.setState({
      followingClientId: null,
      isPlaying: false,
      playheadSec: 3,
      playbackRate: 1,
    });
    const sent: Record<string, unknown>[] = [];
    renderHook(() => usePresencePublisher((frame) => sent.push(frame), "Host"));
    act(() => {
      useDawStore.setState({ playbackRate: 1.5 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const last = sent
      .map((f) => f.meta as Record<string, unknown>)
      .findLast((m) => m.transport != null) as { transport: { rate: number } };
    expect(last.transport.rate).toBe(1.5);
  });
  it("publishes one fresh transport per second, urgent seek/rate edges, and no follower feedback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    useDawStore.setState({
      followingClientId: null,
      isPlaying: true,
      playheadSec: 0,
      playbackRate: 1,
    });
    const sent: Record<string, unknown>[] = [];
    const send = (f: Record<string, unknown>) => sent.push(f);
    const { unmount } = renderHook(() => usePresencePublisher(send, "Host"));
    const transports = () =>
      sent.flatMap((f) => {
        const meta = f.meta as {
          transport?: { playhead_sec: number; rate: number } | null;
        };
        return meta.transport ? [meta.transport] : [];
      });
    sent.length = 0;
    act(() => {
      for (let i = 1; i <= 100; i++) {
        useDawStore.getState().setPlayheadSec(i / 50, "playback");
        vi.advanceTimersByTime(20);
      }
    });
    expect(transports()).toHaveLength(2);
    expect(transports().at(-1)?.playhead_sec).toBe(2);
    act(() => useDawStore.getState().setPlayheadSec(20));
    expect(transports().at(-1)?.playhead_sec).toBe(20);
    expect(transports()).toHaveLength(3);
    act(() => useDawStore.getState().setPlaybackRate(1.5));
    expect(transports().at(-1)?.rate).toBe(1.5);
    expect(transports()).toHaveLength(4);
    act(() => useDawStore.getState().startFollow("leader"));
    sent.length = 0;
    act(() => {
      useDawStore.getState().setPlayheadSec(30);
      useDawStore.getState().setPlaybackRate(1.545);
      vi.advanceTimersByTime(11_000);
    });
    expect(transports()).toEqual([]);
    expect(sent.every((f) => !Object.hasOwn(f, "playhead_sec"))).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes paused seeks, audition jumps, agent seeks, and Stop immediately", () => {
    vi.useFakeTimers();
    useDawStore.setState({
      followingClientId: null,
      isPlaying: false,
      playheadSec: 0,
    });
    const sent: Record<string, unknown>[] = [];
    const { unmount } = renderHook(() =>
      usePresencePublisher((f) => sent.push(f), "Host"),
    );
    const last = () =>
      sent.findLast(
        (f) => (f.meta as { transport?: unknown }).transport != null,
      )?.meta;
    act(() => useDawStore.getState().setPlayheadSec(5));
    expect(last()).toMatchObject({
      transport: { playing: false, playhead_sec: 5 },
    });
    act(() =>
      useDawStore.getState().beginAudition({ playheadSec: 10, untilSec: 20 }),
    );
    expect(last()).toMatchObject({
      transport: { playing: true, playhead_sec: 10 },
    });
    act(() =>
      useDawStore
        .getState()
        .continueAudition({ playheadSec: 30, untilSec: 40 }),
    );
    expect(last()).toMatchObject({
      transport: { playing: true, playhead_sec: 30 },
    });
    act(() => useDawStore.getState().stopPlayback());
    expect(last()).toMatchObject({
      transport: { playing: false, playhead_sec: 10 },
    });
    act(() =>
      useDawStore.getState().applyAgentSession({
        source: null,
        track_id: null,
        match_index: null,
        selection: null,
        viewer_mute: {},
        solo_tracks: {},
        tier: null,
        dry_run: false,
        server_seq: 1,
        version: 1,
        origin: "agent",
        updated_at_ns: 0,
        last_command_id: "agent-seek",
        last_role: "agent",
        audition_mode: "mix",
        playhead_sec: 15,
        is_playing: false,
        region: null,
        query: null,
      }),
    );
    expect(last()).toMatchObject({
      transport: { playing: false, playhead_sec: 15 },
    });
    unmount();
  });
  it("stamps live timeline audio rather than a stale store position", () => {
    const release = bindPlaybackClock(() => 12.25);
    useDawStore.setState({
      followingClientId: null,
      isPlaying: true,
      playheadSec: 12,
    });
    const sent: Record<string, unknown>[] = [];
    const { unmount } = renderHook(() =>
      usePresencePublisher((f) => sent.push(f), "Host"),
    );
    try {
      const transport = sent.find(
        (f) => (f.meta as { transport?: unknown }).transport != null,
      );
      expect(transport).toMatchObject({
        playhead_sec: 12.25,
        meta: { transport: { playhead_sec: 12.25 } },
      });
      act(() => useDawStore.getState().setPlayheadSec(20));
      expect(sent.at(-1)).toMatchObject({
        playhead_sec: 20,
        meta: { transport: { playhead_sec: 20 } },
      });
    } finally {
      unmount();
      release();
    }
  });
});
