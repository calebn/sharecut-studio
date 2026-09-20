import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useFollowTransport } from "./useFollowTransport";

describe("useFollowTransport", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
  });

  it("unfollows when the target leaves", () => {
    useDawStore.setState({
      followingClientId: "gone",
      sessionClients: [],
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("seeks when paused playheads drift", () => {
    useDawStore.setState({
      followingClientId: "a",
      playheadSec: 1,
      isPlaying: false,
      sessionClients: [
        {
          client_id: "a",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: {
            transport: {
              playing: false,
              playhead_sec: 8,
              rate: 1,
              stamped_ns: Date.now() * 1e6,
            },
          },
        },
      ],
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().playheadSec).toBe(8);
  });

  it("starts playback when the leader is already playing", () => {
    const nowNs = Date.now() * 1e6;
    useDawStore.setState({
      followingClientId: "a",
      playheadSec: 0,
      isPlaying: false,
      sessionClients: [
        {
          client_id: "a",
          role: "viewer",
          last_seen_ns: nowNs,
          meta: {
            transport: {
              playing: true,
              playhead_sec: 4,
              rate: 1,
              stamped_ns: nowNs,
            },
          },
        },
      ],
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().playheadSec).toBeGreaterThan(3);
  });

  it("follows the root leader when the target is also following", () => {
    const nowNs = Date.now() * 1e6;
    useDawStore.setState({
      followingClientId: "mid",
      playheadSec: 0,
      isPlaying: false,
      sessionClients: [
        {
          client_id: "mid",
          role: "viewer",
          last_seen_ns: nowNs,
          meta: { following: "lead" },
        },
        {
          client_id: "lead",
          role: "viewer",
          last_seen_ns: nowNs,
          meta: {
            transport: {
              playing: true,
              playhead_sec: 6,
              rate: 1,
              stamped_ns: nowNs,
            },
          },
        },
      ],
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().playheadSec).toBeGreaterThan(5);
  });
});
