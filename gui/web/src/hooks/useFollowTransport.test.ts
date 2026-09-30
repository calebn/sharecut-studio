import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindPlaybackClock } from "../audio/playbackClock";
import { applyServerClock, resetServerClock } from "../presence/clock";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sessionRoster } from "../test/fixtures";
import { useFollowTransport } from "./useFollowTransport";

describe("useFollowTransport", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
  });

  afterEach(() => {
    vi.useRealTimers();
    resetServerClock();
  });

  it("a clock sample alone does not re-render or notify the store", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useDawStore((s) => s.followingClientId);
      useFollowTransport();
    });
    const rendersBefore = renders;
    let notified = false;
    const unsub = useDawStore.subscribe(() => {
      notified = true;
    });
    try {
      applyServerClock(Date.now() * 1e6);
    } finally {
      unsub();
    }
    expect(notified).toBe(false);
    expect(renders).toBe(rendersBefore);
  });

  it("unfollows when the target leaves", () => {
    useDawStore.setState({
      followingClientId: "gone",
      sessionClients: sessionRoster([]),
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("seeks when paused playheads drift", () => {
    useDawStore.setState({
      followingClientId: "a",
      playheadSec: 1,
      isPlaying: false,
      playStartSec: 1,
      sessionClients: sessionRoster([
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
      ]),
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().playheadSec).toBe(8);
    expect(useDawStore.getState().playStartSec).toBeNull();
    useDawStore.getState().stopPlayback();
    expect(useDawStore.getState().playheadSec).toBe(8);
  });

  it("starts playback when the leader is already playing", () => {
    const nowNs = Date.now() * 1e6;
    useDawStore.setState({
      followingClientId: "a",
      playheadSec: 0,
      isPlaying: false,
      sessionClients: sessionRoster([
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
      ]),
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
      sessionClients: sessionRoster([
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
      ]),
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().playheadSec).toBeGreaterThan(5);
  });
  it("corrects on a timer without React playhead renders and keeps the leader rate", () => {
    const release = bindPlaybackClock(() => useDawStore.getState().playheadSec);
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    useDawStore.setState({
      followingClientId: "leader",
      isPlaying: false,
      playbackRate: 1,
      sessionClients: sessionRoster([
        {
          client_id: "leader",
          role: "viewer",
          last_seen_ns: 1e9,
          meta: {
            transport: {
              playing: true,
              playhead_sec: 4,
              rate: 1.5,
              stamped_ns: 1e9,
            },
          },
        },
      ]),
    });
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders += 1;
      useFollowTransport();
    });
    expect(useDawStore.getState().playbackRate).toBe(1.5);
    const afterMount = renders;
    const rateChanges: number[] = [];
    const unsubscribe = useDawStore.subscribe((s, prev) => {
      if (s.playbackRate !== prev.playbackRate)
        rateChanges.push(s.playbackRate);
    });
    act(() => {
      for (let i = 1; i <= 25; i++) {
        useDawStore.getState().setPlayheadSec(4 + i * 0.015, "playback");
        vi.advanceTimersByTime(10);
      }
    });
    expect(renders).toBe(afterMount);
    expect(rateChanges).toEqual([]);
    act(() => {
      useDawStore.getState().setPlayheadSec(4.63, "playback");
      vi.advanceTimersByTime(250);
    });
    expect(useDawStore.getState().playbackRate).toBeCloseTo(1.545);
    unsubscribe();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  it("does not notify on redundant rate writes and preserves same-position seek semantics", () => {
    useDawStore.getState().setPlaybackRate(1);
    const notified = vi.fn();
    const unsubscribe = useDawStore.subscribe(notified);
    useDawStore.getState().setPlaybackRate(1);
    expect(notified).not.toHaveBeenCalled();
    const before = useDawStore.getState().playheadSeekRevision;
    useDawStore.getState().beginSourcePreview({
      ownerId: "wordbar",
      trackId: "host",
      sourceId: null,
      cacheKey: "raw",
      startSec: 0,
      endSec: 1,
    });
    useDawStore.getState().setPlayheadSec(useDawStore.getState().playheadSec);
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(useDawStore.getState().playheadSeekRevision).toBe(before + 1);
    unsubscribe();
  });

  it("applies leader pause/rate edges immediately and stops correcting after unfollow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const leader = {
      client_id: "leader",
      role: "viewer",
      last_seen_ns: 1e9,
      meta: {
        transport: { playing: true, playhead_sec: 4, rate: 1, stamped_ns: 1e9 },
      },
    };
    useDawStore.setState({
      followingClientId: "leader",
      sessionClients: sessionRoster([leader]),
    });
    const { unmount } = renderHook(() => useFollowTransport());
    act(() =>
      useDawStore.getState().setSessionClients([
        {
          ...leader,
          meta: {
            transport: {
              ...leader.meta.transport,
              playing: false,
              playhead_sec: 5,
              rate: 1.2,
            },
          },
        },
      ]),
    );
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().playheadSec).toBe(5);
    expect(useDawStore.getState().playbackRate).toBe(1.2);
    act(() => useDawStore.getState().stopFollow());
    act(() => {
      useDawStore.getState().setPlayheadSec(12);
      vi.advanceTimersByTime(1000);
    });
    expect(useDawStore.getState().playheadSec).toBe(12);
    expect(useDawStore.getState().playbackRate).toBe(1);
    unmount();
  });
  it("corrects remote seeks immediately while ordinary keepalives wait for the timer", () => {
    const release = bindPlaybackClock(() => useDawStore.getState().playheadSec);
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const leader = {
      client_id: "lead",
      role: "viewer",
      last_seen_ns: 1e9,
      meta: {
        transport: { playing: true, playhead_sec: 4, rate: 1, stamped_ns: 1e9 },
      },
    };
    useDawStore.setState({
      followingClientId: "lead",
      isPlaying: false,
      sessionClients: sessionRoster([leader]),
    });
    const { unmount } = renderHook(() => useFollowTransport());
    const revision = useDawStore.getState().playheadSeekRevision;
    const rateWrites = vi.spyOn(useDawStore.getState(), "setPlaybackRate");
    act(() => {
      useDawStore.getState().setSessionClients([
        {
          ...leader,
          meta: {
            transport: {
              ...leader.meta.transport,
              playhead_sec: 4.2,
              stamped_ns: 1.2e9,
            },
          },
        },
      ]);
    });
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
    expect(rateWrites).not.toHaveBeenCalled();
    act(() => {
      useDawStore.getState().setSessionClients([
        {
          ...leader,
          meta: {
            transport: {
              ...leader.meta.transport,
              playhead_sec: 20,
              stamped_ns: 1e9,
            },
          },
        },
      ]);
    });
    expect(useDawStore.getState().playheadSec).toBe(20);
    expect(useDawStore.getState().playheadSeekRevision).toBe(revision + 1);
    act(() => {
      useDawStore.getState().setSessionClients([
        {
          ...leader,
          meta: {
            transport: {
              ...leader.meta.transport,
              playing: false,
              playhead_sec: 21,
            },
          },
        },
      ]);
    });
    act(() => {
      useDawStore.getState().setSessionClients([
        {
          ...leader,
          meta: {
            transport: {
              ...leader.meta.transport,
              playing: false,
              playhead_sec: 21.1,
            },
          },
        },
      ]);
    });
    expect(useDawStore.getState().playheadSec).toBe(21.1);
    expect(useDawStore.getState().isPlaying).toBe(false);
    unmount();
    rateWrites.mockRestore();
    release();
  });
  it("pauses local playback when starting to follow a paused leader", () => {
    useDawStore.setState({
      followingClientId: "lead",
      isPlaying: true,
      sessionClients: sessionRoster([
        {
          client_id: "lead",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: { transport: { playing: false, playhead_sec: 7, rate: 1.2 } },
        },
      ]),
    });
    renderHook(() => useFollowTransport());
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().playheadSec).toBe(7);
    expect(useDawStore.getState().playbackRate).toBe(1.2);
  });
  it("corrects against live audio instead of a stale animation-frame position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let audioPosition = 4;
    const release = bindPlaybackClock(() => audioPosition);
    useDawStore.setState({
      followingClientId: "lead",
      isPlaying: false,
      sessionClients: sessionRoster([
        {
          client_id: "lead",
          role: "viewer",
          last_seen_ns: 1e9,
          meta: {
            transport: {
              playing: true,
              playhead_sec: 4,
              rate: 1,
              stamped_ns: 1e9,
            },
          },
        },
      ]),
    });
    const { unmount } = renderHook(() => useFollowTransport());
    try {
      audioPosition = 4.25;
      await act(() => vi.advanceTimersByTime(250));
      audioPosition = 4.4;
      await act(() => {
        useDawStore.getState().setPlayheadSec(0, "playback");
        vi.advanceTimersByTime(250);
      });
      expect(useDawStore.getState().playheadSec).toBe(0);
      expect(useDawStore.getState().playbackRate).toBe(1.03);
    } finally {
      unmount();
      release();
    }
  });
  it("aligns delayed playback with rate until phase crossing, then keeps the correction policy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let audioPosition: number | null = null;
    const release = bindPlaybackClock(() => audioPosition);
    useDawStore.setState({
      followingClientId: "lead",
      sessionClients: sessionRoster([
        {
          client_id: "lead",
          role: "viewer",
          last_seen_ns: 1e9,
          meta: {
            transport: {
              playing: true,
              playhead_sec: 4,
              rate: 1.5,
              stamped_ns: 1e9,
            },
          },
        },
      ]),
    });
    const { unmount } = renderHook(() => useFollowTransport());
    try {
      const waitingRevision = useDawStore.getState().playheadSeekRevision;
      await act(() => vi.advanceTimersByTime(500));
      expect(useDawStore.getState().playheadSeekRevision).toBe(waitingRevision);
      expect(useDawStore.getState().playbackRate).toBe(1.5);
      audioPosition = 5.075;
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playheadSeekRevision).toBe(waitingRevision);
      expect(useDawStore.getState().playbackRate).toBe(1.545);
      const alignedRevision = useDawStore.getState().playheadSeekRevision;
      audioPosition = 5.51;
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playheadSeekRevision).toBe(alignedRevision);
      expect(useDawStore.getState().playbackRate).toBe(1.5);
      await act(() => useDawStore.getState().stopFollow());
      audioPosition = 0;
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playheadSeekRevision).toBe(alignedRevision);
    } finally {
      unmount();
      release();
    }
  });
  it("expires startup alignment on its derived deadline and clears waiting on pause/resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let ready = true;
    const release = bindPlaybackClock(() =>
      ready ? 4 + (Date.now() - 1000) / 1000 - 0.05 : null,
    );
    const peer = (playing: boolean, playhead_sec = 4) => ({
      client_id: "lead",
      role: "viewer",
      last_seen_ns: Date.now() * 1e6,
      meta: { transport: { playing, playhead_sec, rate: 1, stamped_ns: 1e9 } },
    });
    useDawStore.setState({
      followingClientId: "lead",
      sessionClients: sessionRoster([peer(true)]),
    });
    const { unmount } = renderHook(() => useFollowTransport());
    try {
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playbackRate).toBe(1.03);
      const revision = useDawStore.getState().playheadSeekRevision;
      await act(() => vi.advanceTimersByTime(2250));
      expect(useDawStore.getState().playbackRate).toBe(1);
      expect(useDawStore.getState().playheadSeekRevision).toBe(revision);
      ready = false;
      await act(() =>
        useDawStore.getState().setSessionClients([peer(false, 8)]),
      );
      expect(useDawStore.getState().isPlaying).toBe(false);
      await act(() => useDawStore.getState().setSessionClients([peer(true)]));
      const resumedRevision = useDawStore.getState().playheadSeekRevision;
      await act(() => vi.advanceTimersByTime(500));
      expect(useDawStore.getState().playheadSeekRevision).toBe(resumedRevision);
      expect(useDawStore.getState().playbackRate).toBe(1);
      ready = true;
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playbackRate).toBe(1.03);
      await act(() =>
        useDawStore
          .getState()
          .hydrate("/tmp/new-project.json", minimalProject()),
      );
      const switchedRevision = useDawStore.getState().playheadSeekRevision;
      await act(() => vi.advanceTimersByTime(1000));
      expect(useDawStore.getState().followingClientId).toBeNull();
      expect(useDawStore.getState().playheadSeekRevision).toBe(
        switchedRevision,
      );
    } finally {
      unmount();
      release();
    }
  });
  it("supersedes startup alignment on leader seek, rate, and target changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let audioPosition = 4.2;
    const release = bindPlaybackClock(() => audioPosition);
    const peer = (id: string, position: number, rate = 1) => ({
      client_id: id,
      role: "viewer",
      last_seen_ns: Date.now() * 1e6,
      meta: {
        transport: {
          playing: true,
          playhead_sec: position,
          rate,
          stamped_ns: Date.now() * 1e6,
        },
      },
    });
    useDawStore.setState({
      followingClientId: "lead",
      sessionClients: sessionRoster([peer("lead", 4)]),
    });
    const { unmount } = renderHook(() => useFollowTransport());
    try {
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playbackRate).toBe(1.03);
      await act(() =>
        useDawStore.getState().setSessionClients([peer("lead", 12)]),
      );
      expect(useDawStore.getState().playheadSec).toBe(12);
      expect(useDawStore.getState().playbackRate).toBe(1);
      audioPosition = 12.2;
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playbackRate).toBe(1.03);
      await act(() =>
        useDawStore.getState().setSessionClients([peer("lead", 12.25, 1.5)]),
      );
      expect(useDawStore.getState().playbackRate).toBe(1.545);
      audioPosition = 12.64;
      await act(() => vi.advanceTimersByTime(250));
      expect(useDawStore.getState().playbackRate).toBe(1.5);
      await act(() => {
        useDawStore.getState().setSessionClients([peer("other", 20)]);
        useDawStore.getState().startFollow("other");
      });
      expect(useDawStore.getState().playheadSec).toBe(20);
      expect(useDawStore.getState().playbackRate).toBe(1);
    } finally {
      unmount();
      release();
    }
  });
});
