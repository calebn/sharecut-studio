import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProxyManifest } from "../api";
import { livePlayheadSec } from "../audio/livePlayhead";
import { type ProxyManifest, projectProxyBasis } from "../audio/proxyMath";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { resetDocumentAuthority } from "../document/authorityState";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
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

function manifestFor(): ProxyManifest {
  return {
    revision: "revision",
    project_basis: projectProxyBasis(useDawStore.getState().project!),
    tracks: {
      host: {
        hash: "a".repeat(16),
        chunk_sec: 60,
        overlap_ms: 200,
        chunk_count: 1,
        duration_sec: 60,
        urls: ["u0"],
      },
    },
    artifacts: {},
    occurrences: {},
  };
}

const session = {
  metadata: null as unknown,
  playbackState: "none",
  setActionHandler: vi.fn(),
  setPositionState: vi.fn(),
};

describe("lock screen position against the real proxy transport clock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    resetDocumentAuthority(shareProjectKey("tok"));
    vi.mocked(loadProxyManifest).mockImplementation(async () => manifestFor());
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
    useDawStore.setState({ isPlaying: false, playheadSec: 10 });
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
    expect(livePlayheadSec()).toBe(10);
    let during = Number.NaN;
    act(() => {
      useDawStore.getState().setPlayheadSec(40, "seek");
      during = livePlayheadSec();
    });
    expect(during).toBe(40);
    expect(engine.seek).toHaveBeenCalledWith(40);
    expect(livePlayheadSec()).toBe(10);
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
});
