import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands } from "./execute";
import { executePointerCommand } from "./pointer";
import { registerDawCommands } from "./register";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate(
      "share:tok",
      minimalProject({ timeline_duration_sec: 600 }),
      "comment",
      ["view", "comment"],
    );
  useDawStore.setState({
    stage: "review",
    commentDraft: null,
    isPlaying: false,
    playStartSec: null,
  });
});

describe("comment.draftAt with pause", () => {
  it("pauses playback and tells the draft to resume", async () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    await executePointerCommand("comment.draftAt", { atTime: 86, pause: true });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 86,
      endSec: null,
      resume: true,
    });
  });

  it("leaves a paused transport alone and sets no resume", async () => {
    await executePointerCommand("comment.draftAt", { atTime: 86, pause: true });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 86,
      endSec: null,
    });
  });

  it("keeps playing without the pause argument", async () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    await executePointerCommand("comment.draftAt", { atTime: 86 });
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 86,
      endSec: null,
    });
  });
});
