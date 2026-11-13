import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProxyManifest } from "../api";
import { livePlayheadSec } from "../audio/livePlayhead";
import { ProxyEngine } from "../audio/proxyEngine";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { resetDocumentAuthority } from "../document/authorityState";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { hostProxyManifest } from "../test/proxyManifest";
import { useOsMediaSession } from "./useOsMediaSession";
import { useProxyTransport } from "./useProxyTransport";

const engine = vi.hoisted(() => ({
  setSnapshot: vi.fn(),
  setPlaybackRate: vi.fn(),
  setSolo: vi.fn(),
  setListenMute: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(() => 26),
  seek: vi.fn(),
  currentTimeSec: vi.fn(() => 10),
  dispose: vi.fn(),
  readTrackFrame: vi.fn(() => new Float32Array([0.5])),
}));
vi.mock("../audio/playbackSession", () => ({
  enterPlaybackSession: vi.fn(),
  leavePlaybackSession: vi.fn(),
}));
vi.mock("../audio/proxyEngine", () => ({
  ProxyEngine: vi.fn(function ProxyEngine() {
    return engine;
  }),
}));
vi.mock("../utils/audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audio")>()),
  audioContextCtor: () => class {},
}));
vi.mock("../services/offlineQueue/offlineStore", () => ({
  loadOfflineSnapshot: vi.fn(async () => null),
  loadCommandQueue: vi.fn(async () => []),
  mergeOfflineSnapshot: vi.fn(async () => undefined),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadProxyManifest: vi.fn(),
}));
vi.mock("../audio/chunkCache", () => ({ cachedFetchArrayBuffer: vi.fn() }));

const handlers = new Map<string, MediaSessionActionHandler | null>();
const playbackStateWrites: string[] = [];
let osPlaybackState = "none";
const session = {
  metadata: null as unknown,
  get playbackState() {
    return osPlaybackState;
  },
  set playbackState(value: string) {
    osPlaybackState = value;
    playbackStateWrites.push(value);
  },
  setActionHandler: vi.fn(
    (action: string, handler: MediaSessionActionHandler | null) => {
      handlers.set(action, handler);
    },
  ),
  setPositionState: vi.fn(),
};

describe("lock screen position against the real proxy transport clock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    osPlaybackState = "none";
    playbackStateWrites.length = 0;
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    resetDocumentAuthority(shareProjectKey("tok"));
    vi.mocked(loadProxyManifest).mockImplementation(async () =>
      hostProxyManifest(useDawStore.getState().project!),
    );
    engine.currentTimeSec.mockReturnValue(10);
    vi.stubGlobal(
      "MediaMetadata",
      class {
        title: string;
        constructor(init: { title: string }) {
          this.title = init.title;
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: session,
    });
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate(
      shareProjectKey("tok"),
      minimalProject({
        meta: { name: "Episode", workspace_dir: "/tmp/x" },
        timeline_duration_sec: 60,
        tracks: [sampleTrack({ id: "host" })],
      }),
    );
    useDawStore.setState({
      isPlaying: false,
      playheadSec: 10,
      playbackRate: 1,
    });
  });

  afterEach(() => {
    clearRegisteredCommands();
    useDawStore.setState({ isPlaying: false });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function playing() {
    renderHook(() => {
      useProxyTransport();
      useOsMediaSession();
    });
    await vi.waitFor(() => expect(engine.setSnapshot).toHaveBeenCalled());
    act(() => useDawStore.getState().setIsPlaying(true));
    session.setPositionState.mockClear();
  }

  it("has no live position between a store seek and the engine taking it", async () => {
    await playing();
    engine.currentTimeSec.mockReturnValue(12);
    expect(livePlayheadSec()).toBe(12);
    let during = Number.NaN;
    act(() => {
      useDawStore.getState().setPlayheadSec(40, "seek");
      during = livePlayheadSec();
    });
    expect(during).toBe(40);
    expect(engine.seek).toHaveBeenCalledWith(40);
  });

  it("declares the sought position when a rate change follows the seek in one tick", async () => {
    await playing();
    act(() => {
      useDawStore.getState().setPlayheadSec(40, "seek");
      useDawStore.getState().setPlaybackRate(1.03);
    });
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 60,
      playbackRate: 1.03,
      position: 40,
    });
  });

  it("skips from the engine clock once the engine has taken the seek", async () => {
    await playing();
    act(() => handlers.get("seekto")?.({ action: "seekto", seekTime: 20 }));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 60,
      playbackRate: 1,
      position: 20,
    });
    engine.currentTimeSec.mockReturnValue(30);
    act(() => handlers.get("seekforward")?.({ action: "seekforward" }));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 60,
      playbackRate: 1,
      position: 45,
    });
  });

  /** Episode playing, then a source preview that ends by itself and is never released. */
  function endedPreviewDuringPlay() {
    act(() =>
      useDawStore.getState().beginSourcePreview({
        ownerId: "pending",
        media: { kind: "rendered", url: "u" },
        startSec: 0,
        endSec: 5,
      }),
    );
    const generation = useDawStore.getState().sourcePreview!.generation;
    act(() =>
      useDawStore
        .getState()
        .updateSourcePreview("pending", generation, 5, true),
    );
  }

  it("lock-screen Play after a preview ended on its own puts the episode back on", async () => {
    await playing();
    endedPreviewDuringPlay();
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(session.playbackState).toBe("paused");
    engine.play.mockClear();
    session.setPositionState.mockClear();
    act(() => handlers.get("play")?.({ action: "play" }));
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(engine.play).toHaveBeenLastCalledWith(10);
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 60,
      playbackRate: 1,
      position: expect.any(Number),
    });
  });

  it("lock-screen skip after a preview ended on its own leaves the OS and the audio agreeing", async () => {
    await playing();
    endedPreviewDuringPlay();
    engine.play.mockClear();
    act(() => handlers.get("seekforward")?.({ action: "seekforward" }));
    const audible =
      useDawStore.getState().isPlaying &&
      useDawStore.getState().sourcePreview === null;
    expect(session.playbackState).toBe(audible ? "playing" : "paused");
    expect(engine.play).toHaveBeenCalledTimes(audible ? 1 : 0);
  });
  /** A preview that is still audible: begun and not yet ended. */
  function playingPreview() {
    act(() =>
      useDawStore.getState().beginSourcePreview({
        ownerId: "pending",
        media: { kind: "rendered", url: "u" },
        startSec: 0,
        endSec: 5,
      }),
    );
  }

  const os = (action: "play" | "pause") =>
    act(() => handlers.get(action)?.({ action }));

  describe.each([true, false])(
    "after a preview ended on its own, episode isPlaying %s",
    (episodeWasPlaying) => {
      async function endedPreview() {
        await playing();
        if (!episodeWasPlaying)
          act(() => useDawStore.getState().setIsPlaying(false));
        endedPreviewDuringPlay();
      }

      it("lock-screen Play breaks a Follow like the Player's Play", async () => {
        await endedPreview();
        useDawStore.setState({ followingClientId: "leader" });
        os("play");
        await act(async () => {});
        expect(useDawStore.getState().followingClientId).toBeNull();
        expect(useDawStore.getState().isPlaying).toBe(true);
      });

      it("lock-screen Play never tells the OS paused on its way to playing", async () => {
        await endedPreview();
        expect(osPlaybackState).toBe("paused");
        playbackStateWrites.length = 0;
        os("play");
        await act(async () => {});
        expect(playbackStateWrites).not.toContain("paused");
        expect(osPlaybackState).toBe("playing");
        expect(useDawStore.getState().sourcePreview).toBeNull();
      });

      it("a second lock-screen Play does nothing", async () => {
        await endedPreview();
        os("play");
        await act(async () => {});
        engine.play.mockClear();
        playbackStateWrites.length = 0;
        os("play");
        await act(async () => {});
        expect(engine.play).not.toHaveBeenCalled();
        expect(playbackStateWrites).toEqual([]);
        expect(useDawStore.getState().isPlaying).toBe(true);
      });
    },
  );

  it("lock-screen Play after a block during a preview retries the proxy like the Player's Play", async () => {
    await playing();
    playingPreview();
    const failure = vi.mocked(ProxyEngine).mock.calls.at(-1)?.[2].onFailure;
    act(() =>
      failure?.(new TypeError("Failed to fetch"), {
        kind: "track",
        artifactId: "host",
        hash: "a".repeat(16),
        index: 0,
        url: "chunk-url",
      }),
    );
    expect(useDawStore.getState().audioError).toBe("Failed to fetch");
    expect(useDawStore.getState().isPlaying).toBe(true);
    const generation = useDawStore.getState().sourcePreview!.generation;
    act(() =>
      useDawStore
        .getState()
        .updateSourcePreview("pending", generation, 5, true),
    );
    const loads = vi.mocked(loadProxyManifest).mock.calls.length;
    os("play");
    await vi.waitFor(() =>
      expect(vi.mocked(loadProxyManifest).mock.calls.length).toBeGreaterThan(
        loads,
      ),
    );
  });

  it("lock-screen Play while a preview plays does nothing and keeps a Follow", async () => {
    await playing();
    playingPreview();
    useDawStore.setState({ followingClientId: "leader" });
    playbackStateWrites.length = 0;
    os("play");
    await act(async () => {});
    expect(useDawStore.getState().sourcePreview?.playing).toBe(true);
    expect(useDawStore.getState().followingClientId).toBe("leader");
    expect(playbackStateWrites).toEqual([]);
  });

  it.each([
    ["playing", true],
    ["ended", false],
  ])(
    "lock-screen Pause with a %s preview breaks a Follow and leaves the episode off",
    async (_name, previewPlaying) => {
      await playing();
      if (previewPlaying) playingPreview();
      else endedPreviewDuringPlay();
      useDawStore.setState({ followingClientId: "leader" });
      engine.play.mockClear();
      os("pause");
      await act(async () => {});
      expect(useDawStore.getState().followingClientId).toBeNull();
      expect(useDawStore.getState().sourcePreview).toBeNull();
      expect(useDawStore.getState().isPlaying).toBe(false);
      expect(engine.play).not.toHaveBeenCalled();
      expect(osPlaybackState).toBe("paused");
    },
  );
});
