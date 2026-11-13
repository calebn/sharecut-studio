import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { noComposer } from "../test/composerStore";
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
    ...noComposer,
    isPlaying: false,
    playStartSec: null,
  });
});

describe("comment.draftAt pauses the episode it opens a comment on", () => {
  it("pauses playback and promises to play it on", async () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    await executePointerCommand("comment.draftAt", { atTime: 86 });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 86,
      endSec: null,
    });
    expect(useDawStore.getState().composer.draft?.resume).toBe(true);
  });

  it("leaves a paused transport alone and promises nothing", async () => {
    await executePointerCommand("comment.draftAt", { atTime: 86 });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().composer.draft?.resume).toBe(false);
  });

  it("pauses without an atTime too, as the selection bar does", async () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    await executePointerCommand("comment.draftAt", {});
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().composer.draft?.resume).toBe(true);
  });
});
