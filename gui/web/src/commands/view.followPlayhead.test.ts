import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { playheadScrollRegistry } from "../state/playheadScrollRegistry";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const followFlag = () => useDawStore.getState().timelineFollowPlayhead;

const real = {
  stopFollow: useDawStore.getState().stopFollow,
  announceStatus: useDawStore.getState().announceStatus,
};

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  const base = minimalProject({ tracks: [sampleTrack()] });
  useDawStore.getState().hydrate("/tmp/p.json", {
    ...base,
    timeline_duration_sec: 600,
    clips: {
      tracks: {
        "mira-voice": [
          clipRow({ id: "c1", timeline_start: 100, timeline_end: 110 }),
        ],
      },
      clip_count: 1,
    },
  });
  useDawStore.setState({
    stage: "edit",
    applyAnchoredZoom: vi.fn(),
    fitToWindow: vi.fn(),
    zoomToSpan: vi.fn(),
    measureTimelineViewport: () => 1000,
    selection: { kind: "clip", id: "c1", trackId: "mira-voice" },
    timelineFollowPlayhead: true,
  });
});

afterEach(() => {
  useDawStore.setState({
    isPlaying: false,
    followingClientId: null,
    ...real,
  });
});

describe("view commands suspend the timeline follow", () => {
  it.each([
    ["view.zoomIn", true],
    ["view.zoomOut", true],
    ["view.fit", true],
    ["view.zoomToSelection", true],
    ["view.zoomIn", false],
    ["view.fit", false],
  ])("%s with playing=%s leaves the flag %s", async (id, playing) => {
    useDawStore.setState({ isPlaying: playing });
    expect((await execute(id)).status).toBe("ok");
    expect(followFlag()).toBe(!playing);
  });
});

describe("view.followPlayhead", () => {
  it("re-arms, scrolls only the timeline, and does not stop a presence follow", async () => {
    const stopFollow = vi.fn();
    const announceStatus = vi.fn();
    useDawStore.setState({
      stopFollow,
      announceStatus,
      followingClientId: "leader",
      timelineFollowPlayhead: false,
    });
    const timeline = vi.fn(() => true);
    const script = vi.fn(() => true);
    const offTimeline = playheadScrollRegistry.register("timeline", timeline);
    const offScript = playheadScrollRegistry.register("script", script);

    const result = await execute("view.followPlayhead");

    offTimeline();
    offScript();
    expect(result.status).toBe("ok");
    expect(followFlag()).toBe(true);
    expect(timeline).toHaveBeenCalledTimes(1);
    expect(script).not.toHaveBeenCalled();
    expect(stopFollow).not.toHaveBeenCalled();
    expect(announceStatus).toHaveBeenCalledWith("Following the playhead");
  });

  it("does not announce when the timeline has nothing to scroll, as on the phone", async () => {
    const announceStatus = vi.fn();
    useDawStore.setState({ announceStatus, timelineFollowPlayhead: false });
    const off = playheadScrollRegistry.register("timeline", () => false);

    const result = await execute("view.followPlayhead");

    off();
    expect(result.status).toBe("ok");
    expect(announceStatus).not.toHaveBeenCalled();
  });

  it("is disabled outside the Edit stage", async () => {
    useDawStore.setState({ stage: "deliver" });
    expect((await execute("view.followPlayhead")).status).toBe("disabled");
  });
});
