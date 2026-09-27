import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { useProxyTransport } from "./useProxyTransport";

const engine = vi.hoisted(() => ({
  setManifest: vi.fn(),
  setProject: vi.fn(),
  setSolo: vi.fn(),
  setListenMute: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(() => 26),
  seek: vi.fn(),
  currentTimeSec: vi.fn(() => 30),
  dispose: vi.fn(),
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
vi.mock("../state/offlineStore", () => ({
  loadOfflineSnapshot: vi.fn(async () => null),
  mergeOfflineSnapshot: vi.fn(async () => undefined),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadProxyManifest: vi.fn(async () => ({
    tracks: { host: { urls: ["u0"] } },
  })),
}));

describe("useProxyTransport", () => {
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    engine.pause.mockReturnValue(26);
    engine.currentTimeSec.mockReturnValue(30);
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    useDawStore
      .getState()
      .hydrate(
        shareProjectKey("tok"),
        minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
      );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Stop rewinds the store and seeks the paused engine to the play start", async () => {
    const { result } = renderHook(() => useProxyTransport());
    await vi.waitFor(() => expect(result.current).toBe(true));

    act(() => {
      useDawStore.getState().setPlayheadSec(10);
      useDawStore.getState().setIsPlaying(true);
    });
    expect(engine.play).toHaveBeenCalledWith(10);

    act(() => useDawStore.getState().setPlayheadSec(25));
    act(() => {
      useDawStore.getState().stopPlayback();
      for (const cb of frames.splice(0)) cb(0);
    });

    expect(useDawStore.getState().playheadSec).toBe(10);
    expect(engine.pause).toHaveBeenCalled();
    expect(engine.seek).toHaveBeenLastCalledWith(10);
  });

  it("Pause keeps the store playhead, not the engine's pause time", async () => {
    const { result } = renderHook(() => useProxyTransport());
    await vi.waitFor(() => expect(result.current).toBe(true));

    act(() => {
      useDawStore.getState().setPlayheadSec(10);
      useDawStore.getState().setIsPlaying(true);
    });
    act(() => useDawStore.getState().setPlayheadSec(25));
    act(() => useDawStore.getState().setIsPlaying(false));

    expect(useDawStore.getState().playheadSec).toBe(25);
    expect(engine.seek).toHaveBeenLastCalledWith(25);
  });

  it("a tick that lands after Stop keeps the rewound playhead", async () => {
    const { result } = renderHook(() => useProxyTransport());
    await vi.waitFor(() => expect(result.current).toBe(true));

    act(() => {
      useDawStore.getState().setPlayheadSec(0);
      useDawStore.getState().setIsPlaying(true);
    });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));

    act(() => {
      useDawStore.getState().stopPlayback();
      for (const cb of frames.splice(0)) cb(0);
    });

    expect(useDawStore.getState().playheadSec).toBe(0);
  });
});
