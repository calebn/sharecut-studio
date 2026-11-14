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

describe("comment.draftAt pauses the episode it opens a comment on in the phone Listen layout", () => {
  beforeEach(() => {
    useDawStore.setState({ shellBreakpoint: "phone", guestMode: "comment" });
  });

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

  it("leaves a playing transport alone on a desktop", async () => {
    useDawStore.setState({
      shellBreakpoint: "desktop",
      isPlaying: true,
      playStartSec: 0,
    });
    await executePointerCommand("comment.draftAt", { atTime: 86 });
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().composer.draft?.resume).toBe(false);
  });

  it("pauses without an atTime too, as the selection bar does", async () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    await executePointerCommand("comment.draftAt", {});
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().composer.draft?.resume).toBe(true);
  });
});

describe("comment.draftAt on a selection whose words are refreshing", () => {
  it("is refused with the reason and opens no draft", async () => {
    useDawStore.getState().hydrate(
      "share:tok",
      minimalProject({
        timeline_duration_sec: 600,
        transcript: {
          utterances: [
            {
              track_id: "speaker",
              speaker: "Speaker",
              start: 1,
              end: 7,
              text: "one two",
            },
          ],
        },
        meta: {
          name: "t",
          workspace_dir: "/tmp",
          hydration: { transcript_words: false },
        },
      }),
      "comment",
      ["view", "comment"],
    );
    useDawStore.setState({
      stage: "review",
      playheadSec: 90,
      selection: {
        kind: "transcriptRange",
        trackId: "speaker",
        sourceId: null,
        startWordIndex: 0,
        endWordIndex: 1,
      },
    });
    const result = await executePointerCommand("comment.draftAt", {});
    expect(result).toMatchObject({
      status: "disabled",
      reason: "Refreshing the transcript. Try again in a moment.",
    });
    expect(useDawStore.getState().commentDraft).toBeNull();
  });
});
