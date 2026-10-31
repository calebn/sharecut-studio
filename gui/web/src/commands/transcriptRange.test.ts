import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerTranscriptRangeCommands } from "./transcriptRange";

function projectWithWords(count: number) {
  return minimalProject({
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: count,
          text: "words",
          words: Array.from({ length: count }, (_, i) => ({
            text: `w${i}`,
            start: i,
            end: i + 0.4,
            word_index: i,
          })),
        },
      ],
    },
  });
}

const range = (start: number, end: number) =>
  ({
    kind: "transcriptRange",
    trackId: "host",
    startWordIndex: start,
    endWordIndex: end,
  }) as const;

describe("transcript.extendRange", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerTranscriptRangeCommands();
    useDawStore.setState({
      project: projectWithWords(6),
      selection: range(2, 3),
      statusAnnouncement: "",
      feedbackToast: null,
    });
  });

  it("moves the end by a word, says the count, and shows no toast", async () => {
    expect(
      await execute("transcript.extendRange", { edge: "end", by: 1 }),
    ).toEqual({ status: "ok" });
    expect(useDawStore.getState().selection).toEqual(range(2, 4));
    expect(useDawStore.getState().statusAnnouncement).toBe("3 words selected");
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("moves the start earlier and later", async () => {
    await execute("transcript.extendRange", { edge: "start", by: -1 });
    expect(useDawStore.getState().selection).toEqual(range(1, 3));
    await execute("transcript.extendRange", { edge: "start", by: 1 });
    expect(useDawStore.getState().selection).toEqual(range(2, 3));
  });

  it("refuses with the reason at the end of the transcript", async () => {
    useDawStore.setState({ selection: range(4, 5) });
    expect(
      await execute("transcript.extendRange", { edge: "end", by: 1 }),
    ).toEqual({
      status: "disabled",
      reason: "There is no later word to add.",
    });
    expect(useDawStore.getState().selection).toEqual(range(4, 5));
  });

  it("keeps one word", async () => {
    useDawStore.setState({ selection: range(3, 3) });
    expect(
      await execute("transcript.extendRange", { edge: "end", by: -1 }),
    ).toMatchObject({ status: "disabled" });
    expect(useDawStore.getState().selection).toEqual(range(3, 3));
  });

  it("grows a one-word selection", async () => {
    useDawStore.setState({ selection: range(3, 3) });
    expect(
      await execute("transcript.extendRange", { edge: "end", by: 1 }),
    ).toEqual({ status: "ok" });
    expect(useDawStore.getState().selection).toEqual(range(3, 4));
  });

  it("needs a word range selected", async () => {
    useDawStore.setState({ selection: null });
    expect(
      await execute("transcript.extendRange", { edge: "end", by: 1 }),
    ).toEqual({
      status: "disabled",
      reason: "Select transcript words first",
    });
  });

  it("needs a known edge and step", async () => {
    expect(
      await execute("transcript.extendRange", { edge: "middle", by: 1 }),
    ).toEqual({ status: "disabled", reason: "Choose which edge to move" });
  });
});
