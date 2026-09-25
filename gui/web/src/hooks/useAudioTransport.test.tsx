import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patchTrackMix } from "../document/projectPatch";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { ProjectView, TrackView } from "../types/project";
import { useAudioTransport } from "./useAudioTransport";

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
    expect(useDawStore.getState().audioError).toContain("No premix");
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
    expect(useDawStore.getState().audioError).toContain("No premix");
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
});
