import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { useOsMediaSession } from "./useOsMediaSession";

const handlers = new Map<string, MediaSessionActionHandler | null>();
const session = {
  metadata: null as { title: string } | null,
  playbackState: "none" as string,
  setActionHandler: vi.fn(
    (action: string, handler: MediaSessionActionHandler | null) => {
      handlers.set(action, handler);
    },
  ),
  setPositionState: vi.fn(),
};

const details = (extra: Partial<MediaSessionActionDetails> = {}) =>
  ({ action: "play", ...extra }) as MediaSessionActionDetails;

function hydrateGuest() {
  useDawStore.getState().hydrate(
    shareProjectKey("tok"),
    minimalProject({
      meta: { name: "Episode 12", workspace_dir: "/tmp/x" },
      timeline_duration_sec: 60,
      tracks: [sampleTrack({ id: "host" })],
    }),
  );
}

beforeEach(() => {
  handlers.clear();
  session.metadata = null;
  session.playbackState = "none";
  vi.clearAllMocks();
  vi.stubGlobal(
    "MediaMetadata",
    class {
      title: string;
      constructor(init: { title: string }) {
        this.title = init.title;
      }
    },
  );
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: session,
  });
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({ isPlaying: false, playheadSec: 0 });
});

afterEach(() => {
  clearRegisteredCommands();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaSession");
  useDawStore.setState({ isPlaying: false });
});

describe("useOsMediaSession", () => {
  it("leaves the Media Session alone outside a share link", () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/test/episode.sharecut",
        minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
      );
    renderHook(() => useOsMediaSession());
    expect(session.setActionHandler).not.toHaveBeenCalled();
    expect(session.setPositionState).not.toHaveBeenCalled();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });

  it("claims the title, the handlers and a paused state for a guest", () => {
    hydrateGuest();
    renderHook(() => useOsMediaSession());
    expect(session.metadata?.title).toBe("Episode 12");
    expect(session.playbackState).toBe("paused");
    expect([...handlers].map(([action, fn]) => [action, fn !== null])).toEqual([
      ["play", true],
      ["pause", true],
      ["seekbackward", true],
      ["seekforward", true],
      ["seekto", true],
      ["previoustrack", false],
      ["nexttrack", false],
    ]);
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 60,
      playbackRate: 1,
      position: 0,
    });
  });

  it("declares the position again only when the transport jumps", () => {
    hydrateGuest();
    renderHook(() => useOsMediaSession());
    act(() => useDawStore.getState().setIsPlaying(true));
    expect(session.playbackState).toBe("playing");
    const calls = session.setPositionState.mock.calls.length;
    act(() => {
      for (let i = 0; i < 200; i += 1)
        useDawStore.getState().setPlayheadSec(i / 10, "playback");
    });
    expect(session.setPositionState).toHaveBeenCalledTimes(calls);
    act(() => useDawStore.getState().setPlayheadSec(40, "seek"));
    expect(session.setPositionState).toHaveBeenCalledTimes(calls + 1);
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 60,
      playbackRate: 1,
      position: 40,
    });
  });

  it("drives the transport from the lock-screen handlers", () => {
    hydrateGuest();
    renderHook(() => useOsMediaSession());
    act(() => handlers.get("play")?.(details()));
    expect(useDawStore.getState().isPlaying).toBe(true);
    act(() => handlers.get("pause")?.(details()));
    expect(useDawStore.getState().isPlaying).toBe(false);
    act(() => handlers.get("seekto")?.(details({ seekTime: 40 })));
    expect(useDawStore.getState().playheadSec).toBe(40);
    act(() => handlers.get("seekforward")?.(details()));
    expect(useDawStore.getState().playheadSec).toBe(55);
    act(() => handlers.get("seekbackward")?.(details({ seekOffset: 5 })));
    expect(useDawStore.getState().playheadSec).toBe(50);
  });

  it("clears everything on unmount", () => {
    hydrateGuest();
    const { unmount } = renderHook(() => useOsMediaSession());
    unmount();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(handlers.get("play")).toBeNull();
    expect(session.setPositionState).toHaveBeenLastCalledWith();
  });
});
