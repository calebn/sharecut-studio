import { act, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "../api/http";
import { createHostPlaybackMeterMonitor } from "../audio/hostPlaybackMeterMonitor";
import { playbackPositionSec } from "../audio/playbackClock";
import { playbackMeterSource } from "../audio/playbackMeterSource";
import { clearRegisteredCommands } from "../commands/execute";
import { skipListen } from "../commands/listenSeek";
import { registerDawCommands } from "../commands/register";
import { patchTrackMix } from "../document/projectPatch";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { ProjectView, TrackView } from "../types/project";
import { NO_PREVIEW_ERROR } from "../utils/audioErrorLabel";
import { useAudioTransport } from "./useAudioTransport";

const meterClock = vi.hoisted(() =>
  vi.fn<() => { playbackRate: number } | null>(),
);
const meterTracks = vi.hoisted(() => vi.fn<() => unknown[]>(() => []));

vi.mock("../audio/hostPlaybackMeterMonitor", () => ({
  createHostPlaybackMeterMonitor: vi.fn(
    (options: {
      clock: () => { playbackRate: number } | null;
      tracks: () => unknown[];
    }) => {
      meterClock.mockImplementation(options.clock);
      meterTracks.mockImplementation(options.tracks);
      return { sync: vi.fn(), read: () => null, dispose: vi.fn() };
    },
  ),
}));

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  preload = "";
  src = "";
  playbackRate = 1;
  currentTime = 0;
  duration = 60;
  readyState = 1;
  volume = 1;
  paused = true;
  ended = false;

  constructor() {
    super();
    FakeAudio.instances.push(this);
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
}

function trackProject(mediaPath?: string): ProjectView {
  return minimalProject({
    tracks: [
      sampleTrack({
        duration_sec: mediaPath ? 60 : null,
        media_path: mediaPath ?? null,
      }),
    ],
  });
}

describe("useAudioTransport project transitions", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    useDawStore.getState().hydrate("/tmp/project-a.json", minimalProject());
    useDawStore.getState().setAuditionMode("mix");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["resolve", "reject", "unmount", "pending-probe"])(
    "serializes real meter replacement across project transitions and close %s",
    async (outcome) => {
      const real = await vi.importActual<
        typeof import("../audio/hostPlaybackMeterMonitor")
      >("../audio/hostPlaybackMeterMonitor");
      const factory = vi.mocked(createHostPlaybackMeterMonitor);
      const original = factory.getMockImplementation()!;
      factory.mockImplementation(real.createHostPlaybackMeterMonitor);
      let finishProbe: (() => void) | undefined;
      let staleResponse: Response | undefined;
      const request = vi.spyOn(http, "apiSend").mockImplementation(async () => {
        const bytes = new Uint8Array(12);
        bytes.set(new TextEncoder().encode("fLaC"));
        const response = new Response(bytes, {
          status: 206,
          headers: {
            "content-range": "bytes 0-11/64",
            "content-length": "12",
            etag: '"raw"',
          },
        });
        if (outcome === "pending-probe" && !finishProbe) {
          staleResponse = response;
          return new Promise<Response>((resolve) => {
            finishProbe = () => resolve(response);
          });
        }
        return response;
      });
      const contexts: MeterContext[] = [];
      class MeterContext extends EventTarget {
        state = "running";
        currentTime = 0;
        sampleRate = 48000;
        destination = {};
        finishClose!: () => void;
        rejectClose!: (error: Error) => void;
        analyserCount = 0;
        close = vi.fn(
          () =>
            new Promise<void>((resolve, reject) => {
              this.finishClose = () => {
                this.state = "closed";
                this.dispatchEvent(new Event("statechange"));
                resolve();
              };
              this.rejectClose = reject;
            }),
        );
        resume = vi.fn(async () => {});
        createGain = () => ({
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        });
        createMediaElementSource = () => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        });
        createChannelSplitter = () => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        });
        createAnalyser = () => {
          const value = this.analyserCount++ % 2 === 0 ? 0.25 : -0.125;
          return {
            fftSize: 2048,
            connect: vi.fn(),
            disconnect: vi.fn(),
            getFloatTimeDomainData: (samples: Float32Array) =>
              samples.fill(value),
          };
        };
        constructor() {
          super();
          contexts.push(this);
        }
      }
      vi.stubGlobal("AudioContext", MeterContext);
      let frame: FrameRequestCallback | undefined;
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((callback: FrameRequestCallback) => {
          frame = callback;
          return 1;
        }),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      useDawStore.getState().setProject(trackProject("raw/host.wav"));
      useDawStore.getState().setAuditionMode("raw");
      const { unmount, rerender } = renderHook(
        (enabled) => useAudioTransport(enabled),
        { initialProps: true },
      );
      const start = async () => {
        const audible = FakeAudio.instances.at(-1)!;
        audible.readyState = 4;
        act(() => useDawStore.getState().setIsPlaying(true));
        await act(async () => {});
        audible.currentTime = 12;
        act(() => frame?.(0));
      };
      const prime = async () => {
        const count = FakeAudio.instances.length;
        expect(playbackMeterSource()?.read("host")).toBeNull();
        await act(async () => {
          await vi.waitFor(() =>
            expect(FakeAudio.instances.length).toBeGreaterThan(count),
          );
        });
        const meter = FakeAudio.instances.at(-1)!;
        meter.readyState = 4;
        act(() => frame?.(16));
        await act(async () => {});
        meter.dispatchEvent(new Event("playing"));
        meter.currentTime += 0.01;
        meter.dispatchEvent(new Event("timeupdate"));
        const samples = playbackMeterSource()?.read("host");
        expect(samples?.length).toBe(4096);
        expect([samples?.[0], samples?.[2048]]).toEqual([0.25, -0.125]);
        return meter;
      };
      try {
        await start();
        if (outcome === "pending-probe") {
          const oldSource = playbackMeterSource()!;
          expect(oldSource.read("host")).toBeNull();
          expect(finishProbe).toBeDefined();
          act(() => {
            useDawStore
              .getState()
              .hydrate("/tmp/project-next.json", trackProject("raw/host.wav"));
            useDawStore.getState().setAuditionMode("raw");
          });
          expect(playbackMeterSource()).not.toBe(oldSource);
          await start();
          const currentMeter = await prime();
          const count = FakeAudio.instances.length;
          const cancelled = vi.spyOn(staleResponse!.body!, "cancel");
          await act(async () => {
            finishProbe!();
            await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
          });
          expect(oldSource.read("host")).toBeNull();
          expect(FakeAudio.instances).toHaveLength(count);
          expect(FakeAudio.instances.at(-1)).toBe(currentMeter);
          const samples = playbackMeterSource()?.read("host");
          expect([samples?.[0], samples?.[2048]]).toEqual([0.25, -0.125]);
          expect(contexts).toHaveLength(1);
          unmount();
          await act(async () => contexts[0].finishClose());
          expect(playbackMeterSource()).toBeNull();
          return;
        }
        const oldMeter = await prime();
        const old = contexts[0];
        act(() => {
          useDawStore
            .getState()
            .hydrate("/tmp/project-next.json", trackProject("raw/host.wav"));
          useDawStore.getState().setAuditionMode("raw");
        });
        expect(old.close).toHaveBeenCalledOnce();
        expect(oldMeter.src).toBe("");
        await start();
        old.state = "closed";
        old.dispatchEvent(new Event("statechange"));
        for (let tick = 0; tick < 3; tick++) {
          act(() => frame?.(32 + tick * 16));
          expect(playbackMeterSource()?.read("host")).toBeNull();
          expect(contexts).toHaveLength(1);
        }
        if (outcome === "unmount") {
          unmount();
          await act(async () => old.finishClose());
          expect(playbackMeterSource()).toBeNull();
          expect(contexts).toHaveLength(1);
        } else if (outcome === "reject") {
          await act(async () => old.rejectClose(new Error("close failed")));
          act(() => frame?.(100));
          expect(playbackMeterSource()?.read("host")).toBeNull();
          expect(contexts).toHaveLength(1);
          rerender(false);
          rerender(true);
          await start();
          expect(playbackMeterSource()?.read("host")).toBeNull();
          expect(contexts).toHaveLength(1);
          expect(old.close).toHaveBeenCalledOnce();
        } else {
          await act(async () => old.finishClose());
          act(() => frame?.(100));
          await prime();
          expect(contexts).toHaveLength(2);
          old.state = "suspended";
          old.dispatchEvent(new Event("statechange"));
          oldMeter.dispatchEvent(new Event("error"));
          const samples = playbackMeterSource()?.read("host");
          expect([samples?.[0], samples?.[2048]]).toEqual([0.25, -0.125]);
          unmount();
          expect(contexts[1].close).toHaveBeenCalledOnce();
          await act(async () => contexts[1].finishClose());
          expect(playbackMeterSource()).toBeNull();
          expect(contexts).toHaveLength(2);
        }
      } finally {
        unmount();
        for (const context of contexts) context.finishClose?.();
        await act(async () => {});
        factory.mockImplementation(original);
        request.mockRestore();
      }
    },
  );

  it("applies a small explicit follow seek while playing without chasing clock ticks", async () => {
    useDawStore.getState().setProject(trackProject("raw/host.wav"));
    useDawStore.getState().setAuditionMode("raw");
    const { unmount } = renderHook(() => useAudioTransport());
    act(() => useDawStore.getState().setIsPlaying(true));
    await act(async () => {});
    const player = FakeAudio.instances[0];
    player.currentTime = 10;
    act(() => useDawStore.getState().setPlayheadSec(10.1, "playback"));
    expect(player.currentTime).toBe(10);
    act(() => useDawStore.getState().setPlayheadSec(10.3));
    expect(player.currentTime).toBe(10.3);
    expect(player.paused).toBe(false);
    expect(playbackPositionSec()).toBeNull();
    player.readyState = 4;
    expect(playbackPositionSec()).toBe(10.3);
    act(() => useDawStore.getState().setIsPlaying(false));
    expect(playbackPositionSec() ?? 9).toBe(9);
    unmount();
    expect(playbackPositionSec() ?? 8).toBe(8);
  });

  it("reports no clock between a store seek and the players taking it, so skips stack on the target", async () => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().setProject(trackProject("raw/host.wav"));
    useDawStore.getState().setAuditionMode("raw");
    const { unmount } = renderHook(() => useAudioTransport());
    const player = FakeAudio.instances[0];
    player.readyState = 4;
    act(() => useDawStore.getState().setIsPlaying(true));
    await act(async () => {});
    player.currentTime = 10;
    expect(playbackPositionSec()).toBe(10);

    await act(async () => {
      useDawStore.getState().setPlayheadSec(20);
      expect(playbackPositionSec()).toBeNull();
      skipListen(15, 60);
      await Promise.resolve();
      skipListen(15, 60);
      await Promise.resolve();
    });
    expect(useDawStore.getState().playheadSec).toBe(50);
    expect(player.currentTime).toBe(50);
    expect(playbackPositionSec()).toBe(50);
    unmount();
    clearRegisteredCommands();
  });

  it("withholds meter work until the primary has future data", async () => {
    meterClock.mockReset();
    useDawStore.getState().setProject(trackProject("raw/host.wav"));
    useDawStore.getState().setAuditionMode("raw");
    const { unmount } = renderHook(() => useAudioTransport());
    const player = FakeAudio.instances[0];
    player.readyState = 4;
    act(() => useDawStore.getState().setIsPlaying(true));
    await act(async () => {});
    player.currentTime = 9;

    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(playbackPositionSec()).toBe(9);
    expect(meterClock()).toEqual({ playbackRate: 1 });

    player.readyState = 2;
    expect(playbackPositionSec()).toBe(9);
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(meterClock()).toBeNull();

    player.readyState = 3;
    expect(playbackPositionSec()).toBe(9);
    expect(meterClock()).toEqual({ playbackRate: 1 });

    player.readyState = 4;
    expect(meterClock()).toEqual({ playbackRate: 1 });
    act(() => useDawStore.getState().setIsPlaying(false));
    unmount();
  });

  it("uses an updated audition boundary without replacing the playing source", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const state = useDawStore.getState();
    state.setProject(trackProject("raw/host.wav"));
    state.setAuditionMode("raw");
    state.setPlayUntilSec(30);
    const { unmount } = renderHook(() => useAudioTransport());
    act(() => state.setIsPlaying(true));
    await act(async () => {});
    const player = FakeAudio.instances[0];
    expect(player.paused).toBe(false);
    expect(frames.length).toBeGreaterThan(0);
    act(() => state.setPlayUntilSec(12));
    expect(FakeAudio.instances).toEqual([player]);
    player.currentTime = 13;
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(useDawStore.getState().playheadSec).toBe(12);
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().playUntilSec).toBeNull();
    expect(player.paused).toBe(true);
    unmount();
  });

  it("does not restart clock updates when an old play promise resolves after project change", async () => {
    let finishPlay: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finishPlay = resolve;
    });
    const play = vi
      .spyOn(FakeAudio.prototype, "play")
      .mockImplementation(function (this: FakeAudio) {
        this.paused = false;
        return pending;
      });
    const frames = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", frames);
    useDawStore.getState().setProject(trackProject("raw/host.wav"));
    useDawStore.getState().setAuditionMode("raw");
    const { unmount } = renderHook(() => useAudioTransport());
    try {
      act(() => useDawStore.getState().setIsPlaying(true));
      await act(async () => {});
      expect(play).toHaveBeenCalled();
      expect(playbackPositionSec()).toBeNull();
      act(() =>
        useDawStore
          .getState()
          .hydrate("/tmp/project-next.json", minimalProject()),
      );
      await act(async () => finishPlay?.());
      expect(frames).not.toHaveBeenCalled();
      expect(playbackPositionSec()).toBeNull();
    } finally {
      unmount();
      play.mockRestore();
    }
  });

  it("keeps an empty project and empty track free of an audio error", () => {
    const { unmount } = renderHook(() => useAudioTransport());
    expect(useDawStore.getState().audioError).toBeNull();

    act(() => useDawStore.getState().setProject(trackProject()));
    expect(useDawStore.getState().audioError).toBeNull();
    act(() => useDawStore.getState().setAuditionMode("raw"));
    expect(FakeAudio.instances).toHaveLength(0);
    expect(useDawStore.getState().audioError).toBeNull();
    unmount();
  });

  it("reports a missing premix when a track has media", () => {
    useDawStore.getState().setProject(trackProject("/tmp/host.wav"));
    const { unmount } = renderHook(() => useAudioTransport());
    expect(useDawStore.getState().audioError).toBe(NO_PREVIEW_ERROR);
    unmount();
  });

  it("reports a missing premix for a guest with redacted path and unknown duration", () => {
    const guestProject = trackProject("/tmp/host.wav");
    guestProject.tracks[0].media_path = null;
    guestProject.tracks[0].duration_sec = null;
    guestProject.tracks[0].has_source_audio = true;
    useDawStore
      .getState()
      .hydrate("share:guest", guestProject, "view", ["play"]);

    const { unmount } = renderHook(() => useAudioTransport());
    expect(useDawStore.getState().audioError).toBe(NO_PREVIEW_ERROR);
    unmount();
  });

  it("keeps a player for a clip moved onto a track without its own media", () => {
    const project = trackProject();
    project.clips = {
      clip_count: 1,
      tracks: {
        host: [
          {
            id: "moved",
            track_id: "host",
            source_start: 0,
            source_end: 1,
            timeline_start: 0,
            timeline_end: 1,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: "original-source",
            source_duration_sec: null,
            recording_key: null,
          },
        ],
      },
    };
    useDawStore.getState().setProject(project);
    useDawStore.getState().setAuditionMode("raw");

    const { unmount } = renderHook(() => useAudioTransport());
    expect(FakeAudio.instances).toHaveLength(1);
    unmount();
  });

  it("ignores an old player's error after switching projects", () => {
    useDawStore.getState().setProject(
      minimalProject({
        render_status: {
          needs_rerender: false,
          reconciliation: { stale: false },
          premix: { exists: true },
        },
      }),
    );
    const { unmount } = renderHook(() => useAudioTransport());
    const oldPlayer = FakeAudio.instances[0];
    expect(oldPlayer).toBeDefined();

    act(() => {
      useDawStore.getState().hydrate("/tmp/project-b.json", minimalProject());
    });
    act(() => {
      oldPlayer.dispatchEvent(new Event("error"));
    });
    expect(useDawStore.getState().audioError).toBeNull();
    expect(useDawStore.getState().isPlaying).toBe(false);
    unmount();
  });
});

function mixProject(
  tracks: TrackView[],
  staleVsMix = false,
  extra: { mtime?: number; renderHash?: Record<string, string> } = {},
): ProjectView {
  return minimalProject({
    tracks,
    render_status: {
      needs_rerender: staleVsMix,
      reconciliation: { stale: false },
      premix: {
        exists: true,
        mtime_sec: extra.mtime ?? 1,
        stale_vs_mix: staleVsMix,
      },
      tracks: Object.fromEntries(
        Object.entries(extra.renderHash ?? {}).map(([id, hash]) => [
          id,
          { stem_is_fresh: false, render_hash: hash },
        ]),
      ),
    },
  });
}

/** Volume of each live player (torn-down ones have no src). */
function volumes(): Record<string, number> {
  return Object.fromEntries(
    FakeAudio.instances
      .filter((el) => el.src)
      .map((el) => [
        new URL(el.src, "http://x").searchParams.get("track_id") ?? "premix",
        el.volume,
      ]),
  );
}

describe("useAudioTransport saved mix (#386)", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    useDawStore.getState().hydrate("/tmp/project-a.json", minimalProject());
    useDawStore.getState().setAuditionMode("mix");
  });

  afterEach(() => {
    act(() => useDawStore.getState().setIsPlaying(false));
    vi.unstubAllGlobals();
  });

  it("plays the stems at their output gain once the premix is behind the mix", () => {
    useDawStore
      .getState()
      .setProject(
        mixProject([sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })]),
      );
    const { unmount } = renderHook(() => useAudioTransport());
    expect(Object.keys(volumes())).toEqual(["premix"]);

    act(() =>
      useDawStore
        .getState()
        .setProject(
          mixProject(
            [
              sampleTrack({ id: "host", fader_db: -20 }),
              sampleTrack({ id: "guest", muted: true }),
            ],
            true,
          ),
        ),
    );
    // One audible track still follows its own volume (no normalising up).
    expect(volumes()).toEqual({ host: expect.closeTo(0.1, 6), guest: 0 });
    unmount();
  });

  it("leaves a saved-muted track's boost out of the headroom", () => {
    useDawStore
      .getState()
      .setProject(
        mixProject(
          [
            sampleTrack({ id: "host", fader_db: 12, muted: true }),
            sampleTrack({ id: "guest", fader_db: -6 }),
          ],
          true,
        ),
      );
    const { unmount } = renderHook(() => useAudioTransport());
    expect(volumes()).toEqual({ host: 0, guest: expect.closeTo(0.501, 3) });
    unmount();
  });

  it("reloads a stale stem when a later edit changes what it renders", () => {
    const stale = (hash: string, mtime = 1) =>
      mixProject(
        [
          sampleTrack({ id: "host", stem_is_fresh: false }),
          sampleTrack({ id: "guest" }),
        ],
        true,
        { mtime, renderHash: { host: hash } },
      );
    useDawStore.getState().setProject(stale("edit-1"));
    const { unmount } = renderHook(() => useAudioTransport());
    const first = FakeAudio.instances.length;

    act(() => useDawStore.getState().setProject(stale("edit-2")));
    expect(FakeAudio.instances.length).toBeGreaterThan(first);
    const host = FakeAudio.instances.filter((el) => el.src).at(0);
    expect(host?.src).toContain("edit-2");

    // A Refresh that only rewrites the premix leaves stem players alone.
    const second = FakeAudio.instances.length;
    act(() => useDawStore.getState().setProject(stale("edit-2", 2)));
    expect(FakeAudio.instances.length).toBe(second);
    unmount();
  });

  it("lowers every track by the loudest boost so none clips", () => {
    useDawStore
      .getState()
      .setProject(
        mixProject(
          [
            sampleTrack({ id: "host", fader_db: 6 }),
            sampleTrack({ id: "guest" }),
          ],
          true,
        ),
      );
    const { unmount } = renderHook(() => useAudioTransport());
    expect(volumes()).toEqual({ host: 1, guest: expect.closeTo(0.501, 3) });
    unmount();
  });

  it("a tick that lands after Stop keeps the rewound playhead", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    useDawStore
      .getState()
      .setProject(
        mixProject(
          [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
          true,
        ),
      );
    const { unmount } = renderHook(() => useAudioTransport());
    act(() => useDawStore.getState().setIsPlaying(true));
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    for (const el of FakeAudio.instances) {
      el.currentTime = 30;
    }
    act(() => {
      useDawStore.getState().stopPlayback();
      for (const cb of frames.splice(0)) cb(0);
    });
    expect(useDawStore.getState().playheadSec).toBe(0);
    unmount();
  });

  it("keeps playing through a saved volume or mute change", async () => {
    useDawStore
      .getState()
      .setProject(
        mixProject(
          [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
          true,
        ),
      );
    const { unmount } = renderHook(() => useAudioTransport());
    const players = [...FakeAudio.instances];
    expect(players).toHaveLength(2);

    act(() => useDawStore.getState().setIsPlaying(true));
    await vi.waitFor(() => {
      expect(players.every((el) => !el.paused)).toBe(true);
    });

    act(() => {
      const project = useDawStore.getState().project;
      if (project) {
        useDawStore
          .getState()
          .setProject(patchTrackMix(project, "host", { fader_db: -6 }));
      }
    });
    act(() => {
      const project = useDawStore.getState().project;
      if (project) {
        useDawStore
          .getState()
          .setProject(patchTrackMix(project, "guest", { muted: true }));
      }
    });
    expect(FakeAudio.instances).toEqual(players);
    expect(players.every((el) => !el.paused)).toBe(true);
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(volumes()).toEqual({ host: expect.closeTo(0.501, 3), guest: 0 });
    unmount();
  });

  it.each([
    ["premix", false],
    ["stems", true],
  ])(
    "keeps a guest's %s players playing when only a comment and the history head change",
    async (_name, staleVsMix) => {
      const base = mixProject(
        [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
        staleVsMix,
        { renderHash: { host: "h1", guest: "g1" } },
      );
      useDawStore
        .getState()
        .hydrate("share:guest", base, "comment", ["play", "comment"]);
      const { unmount } = renderHook(() => useAudioTransport());
      const players = [...FakeAudio.instances];
      expect(players.length).toBeGreaterThan(0);
      act(() => useDawStore.getState().setIsPlaying(true));
      await vi.waitFor(() => {
        expect(players.every((el) => !el.paused)).toBe(true);
      });

      act(() => {
        const project = useDawStore.getState().project;
        if (!project) throw new Error("no project");
        useDawStore.getState().setProject({
          ...project,
          comments: [
            ...project.comments,
            { ...project.comments[0], id: "c-new", body: "hi" },
          ].filter(Boolean),
          history: { ...project.history, head_id: "after-comment" },
        });
      });

      expect(FakeAudio.instances).toEqual(players);
      expect(players.every((el) => !el.paused && el.src !== "")).toBe(true);
      expect(useDawStore.getState().isPlaying).toBe(true);
      unmount();
    },
  );
});

describe("exact raw source preview", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    useDawStore
      .getState()
      .hydrate("/tmp/source-preview.json", trackProject("raw/primary.wav"));
    useDawStore.getState().setAuditionMode("raw");
  });
  afterEach(() => vi.unstubAllGlobals());
  it("reuses the source player for range updates without moving the timeline", async () => {
    const state = useDawStore.getState();
    state.setPlayheadSec(42);
    state.beginSourcePreview({
      ownerId: "word",
      media: {
        kind: "raw",
        trackId: "host",
        sourceId: "extra",
        cacheKey: "version",
      },
      startSec: 2,
      endSec: 3,
    });
    const { unmount } = renderHook(() => useAudioTransport());
    await act(async () => {});
    const player = FakeAudio.instances[0];
    expect(player.src).toContain("source_id=extra");
    expect(player.currentTime).toBe(2);
    expect(player.volume).toBe(1);
    act(() =>
      state.beginSourcePreview({
        ownerId: "word",
        media: {
          kind: "raw",
          trackId: "host",
          sourceId: "extra",
          cacheKey: "version",
        },
        startSec: 2.02,
        endSec: 3,
      }),
    );
    await act(async () => {});
    expect(FakeAudio.instances).toHaveLength(1);
    expect(player.currentTime).toBe(2.02);
    expect(useDawStore.getState().playheadSec).toBe(42);
    expect(playbackPositionSec() ?? 42).toBe(42);
    act(() => state.stopPlayback());
    expect(useDawStore.getState().sourcePreview).toBeNull();
    unmount();
  });
});

describe("rendered boundary source preview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the single transport player for the server-issued audition window", async () => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    const state = useDawStore.getState();
    state.hydrate(
      "/tmp/boundary-preview.json",
      trackProject("raw/primary.wav"),
    );
    state.beginSourcePreview({
      ownerId: "boundary-editor",
      media: { kind: "rendered", url: "/api/boundary/audio/opaque?token=host" },
      startSec: 0,
      endSec: 2,
    });
    const { unmount } = renderHook(() => useAudioTransport());
    await act(async () => {});
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.src).toContain(
      "/api/boundary/audio/opaque?token=host",
    );
    expect(FakeAudio.instances[0]?.currentTime).toBe(0);
    act(() => state.releaseSourcePreview("boundary-editor"));
    expect(useDawStore.getState().sourcePreview).toBeNull();
    unmount();
  });
});

describe("source preview asset error ownership", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["source-a", "source-b"],
    ["source-a", null],
    [null, "source-b"],
  ])(
    "ignores %s errors after %s takes over before passive cleanup",
    async (before, after) => {
      FakeAudio.instances = [];
      vi.stubGlobal("Audio", FakeAudio);
      const state = useDawStore.getState();
      state.hydrate("/tmp/asset-ownership", trackProject("raw/primary.wav"));
      state.setIsPlaying(false);
      state.setAuditionMode("raw");
      const begin = (sourceId: string) =>
        state.beginSourcePreview({
          ownerId: "editor",
          media: { kind: "raw", trackId: "host", sourceId, cacheKey: sourceId },
          startSec: 0,
          endSec: 1,
        });
      if (before) begin(before);
      let injectOldError = false;
      const view = renderHook(() => {
        useAudioTransport();
        const sourceId = useDawStore((s) =>
          s.sourcePreview?.media.kind === "raw"
            ? s.sourcePreview.media.sourceId
            : null,
        );
        useLayoutEffect(() => {
          if (injectOldError)
            FakeAudio.instances[0].dispatchEvent(new Event("error"));
        }, [sourceId]);
      });
      await act(async () => {});
      act(() => {
        injectOldError = true;
        if (after) begin(after);
        else state.setIsPlaying(true);
      });
      expect(useDawStore.getState().audioError).toBeNull();
      expect(useDawStore.getState().sourcePreviewError).toBeNull();
      if (after)
        expect(useDawStore.getState().sourcePreview?.playing).toBe(true);
      else expect(useDawStore.getState().isPlaying).toBe(true);
      view.unmount();
    },
  );
});

describe("useAudioTransport meter URL identity", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    meterTracks.mockReset();
    vi.stubGlobal("Audio", FakeAudio);
    useDawStore.getState().hydrate("/tmp/issue3411.json", minimalProject());
    useDawStore.getState().setAuditionMode("mix");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps render intent on a stale stem action and strips it from same-asset reads", () => {
    const project = mixProject([sampleTrack({ stem_is_fresh: false })], true, {
      renderHash: { host: "render-17" },
    });
    useDawStore.getState().setProject(project);
    const { unmount } = renderHook(() => useAudioTransport());

    const [track] = meterTracks();
    expect(track).toEqual({
      id: "host",
      url: "/api/audio?path=%2Ftmp%2Fissue3411.json&kind=stem&track_id=host&rerender=true&v=s-render-17-",
      readUrl:
        "/api/audio?path=%2Ftmp%2Fissue3411.json&kind=stem&track_id=host&v=s-render-17-",
      delivery: "wav",
      gain: 1,
      mediaSec: 0,
    });
    unmount();
  });

  it("uses stable fresh-stem reads and probes raw media without changing its URL", () => {
    useDawStore.getState().setProject(
      mixProject([sampleTrack()], true, {
        renderHash: { host: "render-18" },
      }),
    );
    const fresh = renderHook(() => useAudioTransport());
    const [freshTrack] = meterTracks();
    expect(freshTrack).toEqual({
      id: "host",
      url: "/api/audio?path=%2Ftmp%2Fissue3411.json&kind=stem&track_id=host&v=f-render-18-",
      readUrl:
        "/api/audio?path=%2Ftmp%2Fissue3411.json&kind=stem&track_id=host&v=f-render-18-",
      delivery: "wav",
      gain: 1,
      mediaSec: 0,
    });
    fresh.unmount();

    useDawStore.getState().setAuditionMode("raw");
    useDawStore.getState().setProject(trackProject("/tmp/host.wav"));
    const raw = renderHook(() => useAudioTransport());
    const [rawTrack] = meterTracks();
    expect(rawTrack).toEqual({
      id: "host",
      url: "/api/audio?path=%2Ftmp%2Fissue3411.json&kind=raw&track_id=host",
      readUrl: "/api/audio?path=%2Ftmp%2Fissue3411.json&kind=raw&track_id=host",
      delivery: "probe",
      gain: 1,
      mediaSec: 0,
    });
    raw.unmount();
  });
});
