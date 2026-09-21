import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFollowUi } from "../hooks/useFollowUi";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
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
      sessionClients: [
        {
          client_id: "leader",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: { ui },
        },
      ],
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
        sessionClients: [
          {
            client_id: "leader",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { ui },
          },
        ],
      });
      renderHook(() => useFollowUi());
      expect(useDawStore.getState().mobileMode).toBe(mode);
    },
  );
});
