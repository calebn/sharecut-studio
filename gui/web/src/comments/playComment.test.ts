import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { PLAY_DENIED_REASON } from "../commands/rangeActions";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { TimelineComment } from "../types/project";
import { playComment } from "./playComment";

const comment = {
  id: "c1",
  timeline_start: 30,
  timeline_end: 34,
} as TimelineComment;

const announce = vi.fn();

beforeEach(() => {
  announce.mockClear();
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    playheadSec: 0,
    isPlaying: false,
    playUntilSec: null,
    selection: null,
    followingClientId: "remote-editor",
    announceStatus: announce,
    project: minimalProject({
      timeline_duration_sec: 100,
      tracks: [sampleTrack()],
    }),
  });
});

describe("playComment", () => {
  it("auditions the padded range", () => {
    const begin = vi.fn();
    useDawStore.setState({ beginAudition: begin });
    playComment(comment);
    expect(begin).toHaveBeenCalledWith({ playheadSec: 28, untilSec: 36 });
  });

  it("selects the comment and leaves the followed editor before playback starts", () => {
    const followingAtStart: (string | null)[] = [];
    useDawStore.setState({
      beginAudition: vi.fn(() => {
        followingAtStart.push(useDawStore.getState().followingClientId);
      }),
    });
    playComment(comment);
    expect(followingAtStart).toEqual([null]);
    expect(useDawStore.getState().followingClientId).toBeNull();
    expect(useDawStore.getState().selection).toEqual({
      kind: "comment",
      id: "c1",
    });
  });

  it("plays a point comment around its start", () => {
    const begin = vi.fn();
    useDawStore.setState({ beginAudition: begin });
    playComment({ id: "c2", timeline_start: 10 } as TimelineComment);
    expect(begin).toHaveBeenCalledWith({ playheadSec: 8, untilSec: 12 });
  });

  it("announces why it cannot play", () => {
    const begin = vi.fn();
    useDawStore.setState({
      beginAudition: begin,
      project: minimalProject({ timeline_duration_sec: 100 }),
    });
    playComment(comment);
    expect(begin).not.toHaveBeenCalled();
    expect(useDawStore.getState().followingClientId).toBe("remote-editor");
    expect(announce).toHaveBeenCalledWith("Import audio to play.", {
      tone: "error",
    });
  });

  it("keeps following the editor when a guest may not play", () => {
    useDawStore.setState({
      beginAudition: vi.fn(),
      guestMode: "view",
      shareCapabilities: [],
    });
    playComment(comment);
    expect(useDawStore.getState().followingClientId).toBe("remote-editor");
    expect(announce).toHaveBeenCalledWith(PLAY_DENIED_REASON, {
      tone: "error",
    });
  });
});
