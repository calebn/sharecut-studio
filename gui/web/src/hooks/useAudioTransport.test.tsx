import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ProjectView } from "../types/project";
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
      {
        id: "host",
        label: "Host",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: mediaPath ? 60 : null,
        fx_count: 0,
        stem_is_fresh: true,
        ...(mediaPath ? { media_path: mediaPath } : {}),
      },
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
