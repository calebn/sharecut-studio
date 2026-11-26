import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands } from "./execute";
import { playSpan } from "./playSpan";
import { registerDawCommands } from "./register";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate(
      "/tmp/play-span/episode.sharecut",
      minimalProject({ timeline_duration_sec: 60, tracks: [sampleTrack()] }),
    );
  useDawStore.setState({ isPlaying: false, playUntilSec: null });
});

describe("playSpan", () => {
  it("plays for a guest while the live project is stale", () => {
    const p = useDawStore.getState().project;
    useDawStore.setState({
      project: p && {
        ...p,
        render_status: { ...p.render_status, needs_rerender: true },
      },
      projectPath: "share:token",
      guestMode: "view",
      shareCapabilities: ["view", "play"],
    });
    expect(playSpan(10, 12, 0.5)).toEqual({ status: "ok" });
  });

  it("runs beforeStart once when play is accepted", () => {
    const before = vi.fn();
    playSpan(10, 12, 0.5, before);
    expect(before).toHaveBeenCalledTimes(1);
  });

  it("skips beforeStart when play is refused", () => {
    useDawStore
      .getState()
      .hydrate("/tmp/play-span/empty.sharecut", minimalProject());
    const before = vi.fn();
    expect(playSpan(10, 12, 0.5, before).status).toBe("disabled");
    expect(before).not.toHaveBeenCalled();
  });

  it("ends follow once and says so before the hook and playback", () => {
    useDawStore.setState({ followingClientId: "other" });
    const announce = vi.fn();
    useDawStore.setState({ announceStatus: announce });
    const seen: (string | null)[] = [];
    expect(
      playSpan(10, 12, 0.5, () =>
        seen.push(useDawStore.getState().followingClientId),
      ),
    ).toEqual({ status: "ok" });
    expect(useDawStore.getState().followingClientId).toBeNull();
    expect(seen).toEqual([null]);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("keeps follow when told to", () => {
    useDawStore.setState({ followingClientId: "other" });
    playSpan(10, 12, 0.5, undefined, { keepFollow: true });
    expect(useDawStore.getState().followingClientId).toBe("other");
  });

  it("keeps follow when play is refused", () => {
    useDawStore
      .getState()
      .hydrate("/tmp/play-span/empty.sharecut", minimalProject());
    useDawStore.setState({ followingClientId: "other" });
    expect(playSpan(10, 12, 0.5).status).toBe("disabled");
    expect(useDawStore.getState().followingClientId).toBe("other");
  });

  it("stays silent when not following", () => {
    const announce = vi.fn();
    useDawStore.setState({ followingClientId: null, announceStatus: announce });
    playSpan(10, 12, 0.5);
    expect(announce).not.toHaveBeenCalled();
  });

  it("pads by the default audition pad when none is given", () => {
    expect(playSpan(10, 12)).toEqual({ status: "ok" });
    const s = useDawStore.getState();
    expect(s.playheadSec).toBe(9.5);
    expect(s.playUntilSec).toBe(12.5);
  });

  it("plays the padded span and ends armed with its stop bound", () => {
    expect(playSpan(10, 12, 0.5)).toEqual({ status: "ok" });
    const s = useDawStore.getState();
    expect(s.isPlaying).toBe(true);
    expect(s.playheadSec).toBe(9.5);
    expect(s.playUntilSec).toBe(12.5);
  });
});
