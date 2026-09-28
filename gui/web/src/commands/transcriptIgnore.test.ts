import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import {
  _resetTranscriptIgnoreInFlightForTests,
  registerTranscriptIgnoreCommands,
} from "./transcriptIgnore";

vi.mock("../api", () => ({
  setTranscriptWordsIgnored: vi.fn(async () => ({})),
}));

function projectWithWords(
  ignored: boolean[],
): ReturnType<typeof minimalProject> {
  return minimalProject({
    meta: {
      name: "Test",
      workspace_dir: "/tmp",
      hydration: { transcript_words: true, history_groups: true },
    },
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: 2,
          text: "so um",
          words: ignored.map((flag, i) => ({
            text: `w${i}`,
            start: i,
            end: i + 0.4,
            word_index: i,
            ignored: flag,
          })),
        },
      ],
    },
  });
}

describe("transcript.ignoreWords", () => {
  beforeEach(() => {
    _resetTranscriptIgnoreInFlightForTests();
    clearRegisteredCommands();
    registerTranscriptIgnoreCommands();
    vi.mocked(api.setTranscriptWordsIgnored).mockReset();
    vi.mocked(api.setTranscriptWordsIgnored).mockResolvedValue(undefined);
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: projectWithWords([false, false]),
      selection: {
        kind: "transcriptRange",
        trackId: "host",
        startWordIndex: 0,
        endWordIndex: 1,
      },
      statusAnnouncement: "",
    });
  });

  it("ignores the selected range, sends the captured span text, and announces status", async () => {
    const result = await execute("transcript.ignoreWords", {});
    expect(result).toEqual({ status: "ok" });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      0,
      1,
      true,
      "w0 w1",
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("Ignored selection");
  });

  it("sends null expected text when a word in the range is not loaded", async () => {
    useDawStore.setState({
      project: minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: true, history_groups: true },
        },
        transcript: {
          utterances: [
            {
              track_id: "host",
              speaker: "Host",
              start: 0,
              end: 2,
              text: "so um",
              words: [{ text: "w0", start: 0, end: 0.4, word_index: 0 }],
            },
          ],
        },
      }),
    });
    const result = await execute("transcript.ignoreWords", {});
    expect(result).toEqual({ status: "ok" });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      0,
      1,
      true,
      null,
    );
  });

  it("drops a second ignore while the first is in flight", async () => {
    let release: () => void = () => {};
    vi.mocked(api.setTranscriptWordsIgnored).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined as never);
        }),
    );
    const first = execute("transcript.ignoreWords", {});
    const second = await execute("transcript.ignoreWords", {});
    expect(second).toEqual({
      status: "disabled",
      reason: "Ignore already in progress",
    });
    release();
    expect(await first).toEqual({ status: "ok" });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledTimes(1);
    expect(await execute("transcript.ignoreWords", {})).toEqual({
      status: "ok",
    });
  });

  it("restores when the whole selection is already ignored", async () => {
    useDawStore.setState({ project: projectWithWords([true, true]) });
    await execute("transcript.ignoreWords", {});
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      0,
      1,
      false,
      "w0 w1",
    );
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Restored selection",
    );
  });

  it("honours explicit args over the selection", async () => {
    await execute("transcript.ignoreWords", {
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 0,
      ignored: true,
    });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      0,
      0,
      true,
      "w0",
    );
  });

  it("is disabled for a share key", async () => {
    useDawStore.setState({ projectPath: "share:abc123" });
    const result = await execute("transcript.ignoreWords", {});
    expect(result).toEqual({
      status: "disabled",
      reason: "Ignore is host-only",
    });
    expect(api.setTranscriptWordsIgnored).not.toHaveBeenCalled();
  });

  it("is disabled while transcript words are unhydrated", async () => {
    useDawStore.setState({
      project: minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: false, history_groups: false },
        },
      }),
    });
    const result = await execute("transcript.ignoreWords", {});
    expect(result).toEqual({
      status: "disabled",
      reason: "Transcript words not loaded",
    });
  });

  it("is disabled with no transcript range selected", async () => {
    useDawStore.setState({ selection: null });
    const result = await execute("transcript.ignoreWords", {});
    expect(result).toEqual({
      status: "disabled",
      reason: "No transcript range selected",
    });
  });

  it("announces a failure and returns disabled", async () => {
    vi.mocked(api.setTranscriptWordsIgnored).mockRejectedValueOnce(
      new Error("boom"),
    );
    const result = await execute("transcript.ignoreWords", {});
    expect(result).toEqual({ status: "disabled", reason: "boom" });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Ignore failed: boom",
    );
  });
});
