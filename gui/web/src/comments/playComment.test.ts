import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { TimelineComment } from "../types/project";
import { playComment } from "./playComment";

const comment = {
  id: "c1",
  timeline_start: 30,
  timeline_end: 34,
} as TimelineComment;

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    playheadSec: 0,
    isPlaying: false,
    followingClientId: "remote-editor",
    project: minimalProject({ timeline_duration_sec: 100 }),
  });
});

describe("playComment", () => {
  it("seeks through the transport, which breaks follow, before it auditions the padded range", async () => {
    const begin = vi.fn();
    useDawStore.setState({ beginAudition: begin });
    await playComment(comment);
    expect(useDawStore.getState().followingClientId).toBeNull();
    expect(useDawStore.getState().selection).toEqual({
      kind: "comment",
      id: "c1",
    });
    expect(begin).toHaveBeenCalledWith({ playheadSec: 28, untilSec: 36 });
  });
});
