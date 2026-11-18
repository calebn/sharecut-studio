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
  it.each(["view.zoomIn", "view.zoomOut", "view.fit", "view.zoomToSelection"])(
    "%s while playing sets the flag false",
    async (id) => {
      useDawStore.setState({ isPlaying: true });
      expect((await execute(id)).status).toBe("ok");
      expect(followFlag()).toBe(false);
    },
  );

  it.each(["view.zoomIn", "view.fit"])(
    "%s while paused leaves the flag on",
    async (id) => {
      expect((await execute(id)).status).toBe("ok");
      expect(followFlag()).toBe(true);
    },
  );
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

  it("is disabled outside the Edit stage", async () => {
    useDawStore.setState({ stage: "deliver" });
    expect((await execute("view.followPlayhead")).status).toBe("disabled");
  });
});
