import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProxyManifest } from "../api";
import { loadDocumentState } from "../api/project";
import { cachedFetchArrayBuffer } from "../audio/chunkCache";
import { playbackPositionSec } from "../audio/playbackClock";
import { playbackMeterSource } from "../audio/playbackMeterSource";
import { ProxyEngine } from "../audio/proxyEngine";
import { type ProxyManifest, projectProxyBasis } from "../audio/proxyMath";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../document/authorityState";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  loadCommandQueue,
  loadOfflineSnapshot,
  mergeOfflineSnapshot,
  type QueuedCommand,
} from "../state/offlineStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { ApiError } from "../utils/apiError";
import { useAudioTransport } from "./useAudioTransport";
import { useProxyTransport } from "./useProxyTransport";

const engine = vi.hoisted(() => ({
  setSnapshot: vi.fn(),
  setPlaybackRate: vi.fn(),
  setSolo: vi.fn(),
  setListenMute: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(() => 26),
  seek: vi.fn(),
  currentTimeSec: vi.fn(() => 30),
  dispose: vi.fn(),
  readTrackFrame: vi.fn(() => new Float32Array([0.5])),
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
  loadCommandQueue: vi.fn(async () => []),
  mergeOfflineSnapshot: vi.fn(async () => undefined),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadProxyManifest: vi.fn(async () => manifestFor()),
}));

vi.mock("../api/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/project")>()),
  loadDocumentState: vi.fn(),
}));
vi.mock("../audio/chunkCache", () => ({ cachedFetchArrayBuffer: vi.fn() }));

function manifestFor(project = useDawStore.getState().project!): ProxyManifest {
  return {
    revision: "revision",
    project_basis: projectProxyBasis(project),
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

async function ready(): Promise<void> {
  await vi.waitFor(() => expect(engine.setSnapshot).toHaveBeenCalled());
}

describe("useProxyTransport", () => {
  const frames: FrameRequestCallback[] = [];
  const players: HTMLAudioElement[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    resetDocumentAuthority(shareProjectKey("tok"));
    vi.mocked(loadProxyManifest).mockImplementation(async () => manifestFor());
    vi.mocked(loadOfflineSnapshot).mockResolvedValue(undefined);
    vi.mocked(loadCommandQueue).mockResolvedValue([]);
    engine.pause.mockReturnValue(26);
    engine.currentTimeSec.mockReturnValue(30);
    frames.length = 0;
    players.length = 0;
    vi.stubGlobal("Audio", function Audio() {
      const player = document.createElement("audio");
      Object.defineProperties(player, {
        readyState: { value: 2 },
        duration: { value: 60 },
        paused: { value: true, configurable: true },
      });
      player.play = async () => {
        Object.defineProperty(player, "paused", { value: false });
      };
      player.pause = () => {
        Object.defineProperty(player, "paused", { value: true });
      };
      player.load = () => {};
      players.push(player);
      return player;
    });
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
    useDawStore.getState().setAudioError(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("Stop rewinds the store and seeks the paused engine to the play start", async () => {
    const { result } = renderHook(() => useProxyTransport());
    await ready();
    expect(result.current).toBe(true);

    act(() => {
      useDawStore.getState().setPlayheadSec(10);
      useDawStore.getState().setIsPlaying(true);
    });
    expect(engine.play).toHaveBeenCalledWith(10);
    expect(playbackPositionSec()).toBe(30);

    act(() => useDawStore.getState().setPlayheadSec(25));
    act(() => {
      useDawStore.getState().stopPlayback();
      for (const cb of frames.splice(0)) cb(0);
    });

    expect(useDawStore.getState().playheadSec).toBe(10);
    expect(engine.pause).toHaveBeenCalled();
    expect(engine.seek).toHaveBeenLastCalledWith(10);
    expect(playbackPositionSec()).toBeNull();
  });

  it("Pause keeps the store playhead, not the engine's pause time", async () => {
    const { result } = renderHook(() => useProxyTransport());
    await ready();
    expect(result.current).toBe(true);

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
    await ready();
    expect(result.current).toBe(true);

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
  it("applies the follower playback rate to cached audio", async () => {
    useDawStore.setState({ playbackRate: 1.5 });
    renderHook(() => useProxyTransport());
    await ready();
    expect(engine.setPlaybackRate).toHaveBeenCalledWith(1.5);
    act(() => useDawStore.getState().setPlaybackRate(1.545));
    expect(engine.setPlaybackRate).toHaveBeenLastCalledWith(1.545);
  });
  it("does not count natural ticks as seeks", async () => {
    const { result } = renderHook(() => useProxyTransport());
    await ready();
    expect(result.current).toBe(true);
    act(() => useDawStore.getState().setIsPlaying(true));
    const before = useDawStore.getState().playheadSeekRevision;
    act(() => {
      frames.shift()?.(0);
    });
    expect(useDawStore.getState().playheadSeekRevision).toBe(before);
  });
  it("applies follow correction seeks while playing and ignores natural ticks", async () => {
    const { result } = renderHook(() => useProxyTransport());
    await ready();
    expect(result.current).toBe(true);
    act(() => useDawStore.getState().setIsPlaying(true));
    engine.seek.mockClear();
    act(() => useDawStore.getState().setPlayheadSec(10, "playback"));
    expect(engine.seek).not.toHaveBeenCalled();
    act(() => useDawStore.getState().setPlayheadSec(10.3));
    expect(engine.seek).toHaveBeenCalledExactlyOnceWith(10.3);
  });

  it("yields a playing proxy to an owned preview until release", async () => {
    const { result } = renderHook(() => {
      const ownsTimeline = useProxyTransport();
      useAudioTransport(!ownsTimeline);
      return ownsTimeline;
    });
    await ready();
    expect(result.current).toBe(true);
    act(() => {
      useDawStore.getState().setPlayheadSec(10);
      useDawStore.getState().setIsPlaying(true);
    });
    expect(playbackPositionSec()).toBe(30);
    expect(playbackMeterSource()?.read("host")).toEqual(
      new Float32Array([0.5]),
    );
    const staleProxyTick = frames.at(-1);
    engine.pause.mockClear();
    engine.play.mockClear();
    act(() =>
      useDawStore.getState().beginSourcePreview({
        ownerId: "pending:edit",
        media: { kind: "rendered", url: "blob:pending-preview" },
        startSec: 0,
        endSec: 2,
      }),
    );
    await act(async () => {});
    expect(result.current).toBe(false);
    const previewPlayer = players.find((player) =>
      player.src.startsWith("blob:"),
    );
    expect(previewPlayer?.src).toBe("blob:pending-preview");
    expect(previewPlayer?.paused).toBe(false);
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(engine.play).not.toHaveBeenCalled();
    act(() => staleProxyTick?.(0));
    expect(useDawStore.getState().playheadSec).toBe(10);
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(playbackPositionSec()).toBeNull();
    expect(playbackMeterSource()).toBeNull();
    if (!previewPlayer) throw new Error("Preview player missing");
    act(() => {
      previewPlayer.currentTime = 2;
      frames.at(-1)?.(0);
    });
    expect(useDawStore.getState().sourcePreview?.playing).toBe(false);
    expect(previewPlayer.paused).toBe(true);
    expect(result.current).toBe(false);
    expect(useDawStore.getState().playheadSec).toBe(10);
    act(() => useDawStore.getState().releaseSourcePreview("pending:edit"));
    expect(result.current).toBe(true);
    expect(engine.play).toHaveBeenLastCalledWith(10);
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(previewPlayer.src).toBe("");
    expect(playbackPositionSec()).toBe(30);
  });

  it("disposes the suspended proxy and preview when the project changes", async () => {
    const { result } = renderHook(() => {
      const ownsTimeline = useProxyTransport();
      useAudioTransport(!ownsTimeline);
      return ownsTimeline;
    });
    await ready();
    expect(result.current).toBe(true);
    act(() =>
      useDawStore.getState().beginSourcePreview({
        ownerId: "pending:edit",
        media: { kind: "rendered", url: "blob:pending-preview" },
        startSec: 0,
        endSec: 2,
      }),
    );
    await act(async () => {});
    const previewPlayer = players.find((player) =>
      player.src.startsWith("blob:"),
    );
    expect(previewPlayer?.paused).toBe(false);
    act(() =>
      useDawStore.getState().hydrate("/tmp/new-project", minimalProject()),
    );
    expect(result.current).toBe(false);
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(previewPlayer?.paused).toBe(true);
    expect(previewPlayer?.src).toBe("");
    expect(engine.dispose).toHaveBeenCalled();
    expect(useDawStore.getState().playheadSec).toBe(0);
  });

  it("owns the share while loading and never starts a stale HTML premix on failure", async () => {
    let release!: (value: ProxyManifest | null) => void;
    vi.mocked(loadProxyManifest).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => {
      const owns = useProxyTransport();
      useAudioTransport(!owns);
      return owns;
    });
    expect(result.current).toBe(true);
    act(() => {
      useDawStore.getState().setPlayheadSec(10);
      useDawStore.getState().setIsPlaying(true);
    });
    expect(engine.play).not.toHaveBeenCalled();
    await act(async () => release(null));
    await vi.waitFor(() =>
      expect(useDawStore.getState().audioError).toBeTruthy(),
    );
    expect(result.current).toBe(true);
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(engine.setSnapshot).not.toHaveBeenCalled();
    expect(useDawStore.getState().playheadSec).toBe(10);
    expect(players.every((player) => player.paused)).toBe(true);
  });

  it.each(["track", "artifact"] as const)(
    "retains generation ownership when a %s chunk fails with CORS",
    async (kind) => {
      const fixture = moveFixture();
      useDawStore.getState().setProject(fixture.base);
      const id = "b".repeat(64);
      const manifest =
        kind === "artifact"
          ? {
              ...fixture.manifest,
              artifacts: {
                [id]: { ...fixture.manifest.tracks.host, hash: id },
              },
              occurrences: { c: { artifactId: id, outputTrackId: "host" } },
            }
          : fixture.manifest;
      vi.mocked(loadProxyManifest).mockResolvedValue(manifest);
      const { result } = renderHook(() => {
        const owns = useProxyTransport();
        useAudioTransport(!owns);
        return owns;
      });
      await ready();
      act(() => useDawStore.getState().setIsPlaying(true));
      const failure = vi.mocked(ProxyEngine).mock.calls.at(-1)?.[2];
      act(() =>
        failure?.(new TypeError("Failed to fetch"), {
          kind,
          artifactId: kind === "artifact" ? id : "host",
          hash: kind === "artifact" ? id : "a".repeat(16),
          index: 0,
          url: "chunk-url",
        }),
      );
      expect(result.current).toBe(true);
      expect(useDawStore.getState().isPlaying).toBe(false);
      expect(useDawStore.getState().audioError).toBe("Failed to fetch");
      expect(players).toHaveLength(0);
    },
  );

  it("retries a blocked proxy on the next Play and stops again if it still fails", async () => {
    const { result } = renderHook(() => {
      const owns = useProxyTransport();
      useAudioTransport(!owns);
      return owns;
    });
    await ready();
    act(() => useDawStore.getState().setIsPlaying(true));
    const failure = vi.mocked(ProxyEngine).mock.calls.at(-1)?.[2];
    act(() =>
      failure?.(new TypeError("Failed to fetch"), {
        kind: "track",
        artifactId: "host",
        hash: "a".repeat(16),
        index: 0,
        url: "chunk-url",
      }),
    );
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().audioError).toBe("Failed to fetch");
    const loads = vi.mocked(loadProxyManifest).mock.calls.length;
    vi.mocked(loadProxyManifest).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    act(() => useDawStore.getState().setIsPlaying(true));
    await vi.waitFor(() =>
      expect(vi.mocked(loadProxyManifest).mock.calls.length).toBeGreaterThan(
        loads,
      ),
    );
    await vi.waitFor(() =>
      expect(useDawStore.getState().isPlaying).toBe(false),
    );
    expect(useDawStore.getState().audioError).toBe("Failed to fetch");
    expect(result.current).toBe(true);
  });

  it("plays again on the next Play once the proxy recovers", async () => {
    renderHook(() => {
      const owns = useProxyTransport();
      useAudioTransport(!owns);
      return owns;
    });
    await ready();
    act(() => useDawStore.getState().setIsPlaying(true));
    const failure = vi.mocked(ProxyEngine).mock.calls.at(-1)?.[2];
    act(() =>
      failure?.(new TypeError("Failed to fetch"), {
        kind: "track",
        artifactId: "host",
        hash: "a".repeat(16),
        index: 0,
        url: "chunk-url",
      }),
    );
    engine.play.mockClear();

    act(() => useDawStore.getState().setIsPlaying(true));
    await vi.waitFor(() => expect(engine.play).toHaveBeenCalled());
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().audioError).toBeNull();
  });

  it("refuses an older generation after the displayed project revision advances", async () => {
    const cached = manifestFor();
    const current = structuredClone(useDawStore.getState().project!);
    current.history.head_id = "after-restore" as typeof current.history.head_id;
    useDawStore.getState().setProject(current);
    vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
    vi.mocked(loadOfflineSnapshot).mockResolvedValue({
      manifest: cached,
      saved_at: 1,
    });
    const { result } = renderHook(() => {
      const owns = useProxyTransport();
      useAudioTransport(!owns);
      return owns;
    });
    await vi.waitFor(() =>
      expect(useDawStore.getState().audioError).toBeTruthy(),
    );
    expect(result.current).toBe(true);
    expect(engine.setSnapshot).not.toHaveBeenCalled();
    expect(players).toHaveLength(0);
  });

  it("uses the immutable copied URL through the permanent engine fetch callback", async () => {
    renderHook(() => useProxyTransport());
    await ready();
    const fetch = vi.mocked(ProxyEngine).mock.calls.at(-1)?.[1];
    await fetch?.({
      kind: "artifact",
      artifactId: "b".repeat(64),
      hash: "b".repeat(64),
      index: 2,
      url: "copied-url",
    });
    expect(cachedFetchArrayBuffer).toHaveBeenCalledExactlyOnceWith(
      useDawStore.getState().projectPath,
      "copied-url",
    );
  });

  it("keeps an unchanged basis through object refreshes without a manifest or engine loop", async () => {
    renderHook(() => useProxyTransport());
    await ready();
    const calls = vi.mocked(ProxyEngine).mock.calls.length;
    act(() =>
      useDawStore
        .getState()
        .setProject(structuredClone(useDawStore.getState().project!)),
    );
    await act(async () => {});
    expect(loadProxyManifest).toHaveBeenCalledOnce();
    expect(ProxyEngine).toHaveBeenCalledTimes(calls);
    expect(engine.setSnapshot.mock.calls.at(-1)?.[0].tracks).toEqual(
      useDawStore.getState().project?.tracks,
    );
  });

  it.each(["head", "hash"])(
    "refuses a first Restore or authored %s advance behind an empty cached manifest",
    async (advance) => {
      const cached = manifestFor();
      renderHook(() => useProxyTransport());
      await ready();
      act(() => useDawStore.getState().setIsPlaying(true));
      vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
      vi.mocked(loadOfflineSnapshot).mockResolvedValue({
        manifest: cached,
        saved_at: 1,
      });
      const project = structuredClone(useDawStore.getState().project!);
      if (advance === "head")
        project.history.head_id =
          "first-restore" as typeof project.history.head_id;
      else
        project.render_status.tracks = { host: { render_hash: "new-render" } };
      engine.setSnapshot.mockClear();
      const { projectPath } = useDawStore.getState();
      act(() => useDawStore.getState().setProject(project));
      await vi.waitFor(() =>
        expect(useDawStore.getState().audioError).toBeTruthy(),
      );
      expect(useDawStore.getState().isPlaying).toBe(false);
      expect(useDawStore.getState().playheadSec).toBe(26);
      expect(engine.setSnapshot).not.toHaveBeenCalled();
      expect(useDawStore.getState().projectPath).toBe(projectPath);
    },
  );

  it("plays a matching offline pair without a document authority token", async () => {
    const cached = manifestFor();
    vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
    vi.mocked(loadOfflineSnapshot).mockResolvedValue({
      manifest: cached,
      saved_at: 1,
    });
    renderHook(() => useProxyTransport());
    await ready();
    expect(documentAuthority.token).toBeNull();
    expect(loadCommandQueue).not.toHaveBeenCalled();
    expect(mergeOfflineSnapshot).not.toHaveBeenCalled();
    act(() => useDawStore.getState().setIsPlaying(true));
    expect(engine.play).toHaveBeenCalled();
  });

  function moveFixture() {
    const base = minimalProject({
      tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
      clips: {
        clip_count: 1,
        tracks: {
          host: [
            {
              id: "c",
              track_id: "host",
              source_start: 0,
              source_end: 5,
              timeline_start: 0,
              timeline_end: 5,
              fade_in_ms: 0,
              fade_out_ms: 0,
              join_in_mode: "fade",
              source_id: null,
              source_duration_sec: null,
              recording_key: null,
            },
          ],
        },
      },
    });
    const moved = structuredClone(base);
    moved.clips.tracks = {
      guest: [
        {
          ...base.clips.tracks.host[0],
          track_id: "guest",
          origin_track_id: "host",
          timeline_start: 10,
          timeline_end: 15,
        },
      ],
    };
    const queue: QueuedCommand[] = [
      {
        client_id: "client",
        command_id: "move",
        client_seq: 1,
        created_at: 1,
        type: "MoveClips",
        payload: {
          clips: [{ clip_id: "c", track_id: "guest", timeline_start: 10 }],
        },
      },
    ];
    return { base, moved, queue, manifest: manifestFor(base) };
  }

  it("admits a proven queued move before and after offline reload", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fixture = moveFixture();
    useDawStore.getState().setProject(fixture.base);
    vi.mocked(loadProxyManifest).mockResolvedValue(fixture.manifest);
    const first = renderHook(() => useProxyTransport());
    await ready();
    vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
    vi.mocked(loadOfflineSnapshot).mockResolvedValue({
      manifest: fixture.manifest,
      project: fixture.moved,
      saved_at: 1,
    });
    vi.mocked(loadCommandQueue).mockResolvedValue(fixture.queue);
    engine.setSnapshot.mockClear();
    act(() => useDawStore.getState().setProject(fixture.moved));
    await ready();
    expect(engine.setSnapshot.mock.calls.at(-1)?.[0].clipsByTrack).toEqual(
      fixture.moved.clips.tracks,
    );
    expect(useDawStore.getState().audioError).toBeNull();
    first.unmount();
    engine.setSnapshot.mockClear();
    renderHook(() => useProxyTransport());
    await ready();
    expect(loadCommandQueue).toHaveBeenCalledTimes(2);
    act(() => useDawStore.getState().setIsPlaying(true));
    expect(engine.play).toHaveBeenCalled();
  });

  it.each(["missing", "unsupported", "variant"])(
    "refuses a mismatched offline overlay with %s proof",
    async (kind) => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      const fixture = moveFixture();
      useDawStore.getState().setProject(fixture.moved);
      let manifest = fixture.manifest;
      if (kind === "variant") {
        const id = "b".repeat(64);
        manifest = {
          ...manifest,
          artifacts: { [id]: { ...manifest.tracks.host, hash: id } },
          occurrences: { c: { artifactId: id, outputTrackId: "host" } },
        };
      }
      vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
      vi.mocked(loadOfflineSnapshot).mockResolvedValue({
        manifest,
        saved_at: 1,
      });
      vi.mocked(loadCommandQueue).mockResolvedValue(
        kind === "missing"
          ? []
          : kind === "unsupported"
            ? [{ ...fixture.queue[0], type: "SplitClip" }]
            : fixture.queue,
      );
      const { result } = renderHook(() => useProxyTransport());
      await vi.waitFor(() =>
        expect(useDawStore.getState().audioError).toBeTruthy(),
      );
      expect(result.current).toBe(true);
      expect(engine.setSnapshot).not.toHaveBeenCalled();
    },
  );

  it("rejects a delayed queue result after a share path switch", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fixture = moveFixture();
    useDawStore.getState().setProject(fixture.moved);
    vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
    vi.mocked(loadOfflineSnapshot).mockResolvedValue({
      manifest: fixture.manifest,
      saved_at: 1,
    });
    let release!: (value: QueuedCommand[]) => void;
    vi.mocked(loadCommandQueue).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useProxyTransport());
    await vi.waitFor(() => expect(loadCommandQueue).toHaveBeenCalled());
    act(() => useDawStore.getState().hydrate("/other", minimalProject()));
    await act(async () => release(fixture.queue));
    expect(result.current).toBe(false);
    expect(engine.setSnapshot).not.toHaveBeenCalled();
    expect(useDawStore.getState().audioError).toBeNull();
  });

  it.each(["HTTP 503", "invalid manifest"])(
    "refuses a queued cached move after an online %s response",
    async (failure) => {
      const fixture = moveFixture();
      useDawStore.getState().setProject(fixture.moved);
      const api = await vi.importActual<typeof import("../api")>("../api");
      vi.mocked(loadProxyManifest).mockImplementation(api.loadProxyManifest);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          failure === "HTTP 503"
            ? new Response("Unavailable", { status: 503 })
            : Response.json({ tracks: {} }),
        ),
      );
      vi.mocked(loadOfflineSnapshot).mockResolvedValue({
        manifest: fixture.manifest,
        project: fixture.moved,
        saved_at: 1,
      });
      vi.mocked(loadCommandQueue).mockResolvedValue(fixture.queue);
      const { result } = renderHook(() => useProxyTransport());
      await vi.waitFor(() =>
        expect(useDawStore.getState().audioError).toBeTruthy(),
      );
      expect(navigator.onLine).toBe(true);
      expect(result.current).toBe(true);
      expect(engine.setSnapshot).not.toHaveBeenCalled();
      expect(engine.play).not.toHaveBeenCalled();
    },
  );

  it("refuses a cached move when the browser reconnects during queue loading", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fixture = moveFixture();
    useDawStore.getState().setProject(fixture.moved);
    vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
    vi.mocked(loadOfflineSnapshot).mockResolvedValue({
      manifest: fixture.manifest,
      saved_at: 1,
    });
    let release!: (value: QueuedCommand[]) => void;
    vi.mocked(loadCommandQueue).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderHook(() => useProxyTransport());
    await vi.waitFor(() => expect(loadCommandQueue).toHaveBeenCalled());
    online.mockReturnValue(true);
    await act(async () => release(fixture.queue));
    await vi.waitFor(() =>
      expect(useDawStore.getState().audioError).toBeTruthy(),
    );
    expect(engine.setSnapshot).not.toHaveBeenCalled();
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("recovers a coded unavailable reference once and never loops on ordinary failures", async () => {
    renderHook(() => useProxyTransport());
    await ready();
    const ref = {
      kind: "track" as const,
      artifactId: "host",
      hash: "a".repeat(16),
      index: 0,
      url: "u0",
    };
    const failure = vi.mocked(ProxyEngine).mock.calls.at(-1)?.[2];
    act(() =>
      failure?.(
        new ApiError("unavailable", "proxy_generation_unavailable", 404),
        ref,
      ),
    );
    await vi.waitFor(() => expect(loadProxyManifest).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(useDawStore.getState().audioError).toBeNull(),
    );
    act(() =>
      failure?.(
        new ApiError("unavailable", "proxy_generation_unavailable", 404),
        ref,
      ),
    );
    await act(async () => {});
    expect(loadProxyManifest).toHaveBeenCalledTimes(2);
    act(() => failure?.(new Error("network"), { ...ref, index: 1 }));
    await act(async () => {});
    expect(loadProxyManifest).toHaveBeenCalledTimes(2);
    expect(useDawStore.getState().audioError).toBe("network");
  });

  it("uses document recovery for a newer manifest and admits the recovered pair", async () => {
    const old = useDawStore.getState().project!;
    const newer = structuredClone(old);
    newer.history.head_id = "new-head" as typeof newer.history.head_id;
    const manifest = manifestFor(newer);
    applyDocumentSnapshot({ project: old, server_seq: 1, state_token: "old" });
    vi.mocked(loadProxyManifest).mockResolvedValue(manifest);
    vi.mocked(loadDocumentState).mockResolvedValue({
      project: newer,
      server_seq: 2,
      state_token: "new",
    });
    renderHook(() => useProxyTransport());
    await ready();
    expect(documentAuthority.token).toBe("new");
    expect(loadDocumentState).toHaveBeenCalledOnce();
    expect(loadProxyManifest).toHaveBeenCalledOnce();
    expect(
      engine.setSnapshot.mock.calls.at(-1)?.[0].manifest.project_basis
        .history_head_id,
    ).toBe("new-head");
  });

  it("recovers the next document delta after a derived save without refetching the unchanged proxy basis", async () => {
    const original = useDawStore.getState().project!;
    applyDocumentSnapshot({
      project: original,
      server_seq: 1,
      state_token: "before-derived-save",
    });
    renderHook(() => useProxyTransport());
    await ready();
    const history = structuredClone(original.history);
    const recovered = {
      ...original,
      meta: { ...original.meta, name: "Next document snapshot" },
    };
    vi.mocked(loadDocumentState).mockResolvedValue({
      project: recovered,
      server_seq: 2,
      state_token: "after-delta",
    });
    act(() => {
      applyDocumentSnapshot({
        server_seq: 2,
        state_token: "after-delta",
        delta: {
          audience: "guest",
          projection: "shell",
          base_seq: 1,
          base_token: "after-derived-save",
          operations: [],
        },
      });
    });
    await vi.waitFor(() => expect(documentAuthority.token).toBe("after-delta"));
    expect(useDawStore.getState().project?.meta.name).toBe(
      "Next document snapshot",
    );
    expect(useDawStore.getState().project?.history).toEqual(history);
    expect(loadDocumentState).toHaveBeenCalledOnce();
    expect(loadProxyManifest).toHaveBeenCalledOnce();
    expect(mergeOfflineSnapshot).toHaveBeenCalledOnce();
  });

  it("discards a delayed network manifest after the displayed basis advances", async () => {
    const previous = manifestFor();
    let release!: (value: ProxyManifest) => void;
    vi.mocked(loadProxyManifest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderHook(() => useProxyTransport());
    const newer = structuredClone(useDawStore.getState().project!);
    newer.history.head_id = "new-head" as typeof newer.history.head_id;
    act(() => useDawStore.getState().setProject(newer));
    await ready();
    expect(
      engine.setSnapshot.mock.calls.at(-1)?.[0].manifest.project_basis
        .history_head_id,
    ).toBe("new-head");
    engine.setSnapshot.mockClear();
    await act(async () => release(previous));
    expect(engine.setSnapshot).not.toHaveBeenCalled();
    expect(useDawStore.getState().audioError).toBeNull();
  });

  it("admits a matched cached occurrence artifact and preserves another transport's error", async () => {
    const fixture = moveFixture();
    useDawStore.getState().setProject(fixture.base);
    useDawStore.getState().setAudioError("Preview failed");
    const id = "b".repeat(64);
    const manifest = {
      ...fixture.manifest,
      artifacts: { [id]: { ...fixture.manifest.tracks.host, hash: id } },
      occurrences: { c: { artifactId: id, outputTrackId: "host" } },
    };
    vi.mocked(loadProxyManifest).mockRejectedValue(new Error("offline"));
    vi.mocked(loadOfflineSnapshot).mockResolvedValue({ manifest, saved_at: 1 });
    renderHook(() => useProxyTransport());
    await ready();
    expect(
      engine.setSnapshot.mock.calls.at(-1)?.[0].manifest.occurrences.c,
    ).toEqual({ artifactId: id, outputTrackId: "host" });
    expect(useDawStore.getState().audioError).toBe("Preview failed");
    expect(loadCommandQueue).not.toHaveBeenCalled();
  });
});
