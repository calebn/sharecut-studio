import { beforeEach, describe, expect, it } from "vitest";
import { presenceAnchor } from "../presence/anchors";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import { registerTranscriptReviewCommands } from "./transcriptReview";

function project(): ProjectView {
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
          end: 3,
          text: "we are learning",
          mappable: true,
          words: [
            {
              text: "we",
              start: 0,
              end: 0.5,
              word_index: 0,
              confidence: 0.9,
              timeline_start: 0,
            },
            {
              text: "are",
              start: 0.5,
              end: 1,
              word_index: 1,
              confidence: 0.4,
              timeline_start: 0.5,
            },
            {
              text: "learning",
              start: 1,
              end: 1.5,
              word_index: 2,
              confidence: 0.5,
              timeline_start: 1,
            },
          ],
        },
        {
          track_id: "guest",
          speaker: "Guest",
          start: 3,
          end: 4,
          text: "yes",
          mappable: true,
          words: [
            {
              text: "yes",
              start: 3,
              end: 3.5,
              word_index: 0,
              confidence: 0.3,
              timeline_start: 3,
            },
          ],
        },
        {
          track_id: "guest",
          speaker: "Guest",
          start: 4,
          end: 4.5,
          text: "cut",
          mappable: false,
          words: [
            {
              text: "cut",
              start: 4,
              end: 4.5,
              word_index: 1,
              confidence: 0.2,
              mappable: false,
            },
          ],
        },
      ],
    },
  });
}

describe("transcript.next/prevLowConfidence", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerTranscriptReviewCommands();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: project(),
      transcriptAnnotate: false,
      showCutAwayUtterances: false,
      transcriptReviewCursor: null,
      statusAnnouncement: "",
      transcriptScrollRequest: null,
      playheadSec: 0,
    });
  });

  it("visits host:1, host:2, guest:0 then wraps", async () => {
    const expected: [string, number, string][] = [
      ["host", 1, "are"],
      ["host", 2, "learning"],
      ["guest", 0, "yes"],
      ["host", 1, "are"],
    ];
    for (let i = 0; i < expected.length; i++) {
      const [trackId, wordIndex, text] = expected[i];
      const result = await execute("transcript.nextLowConfidence", {});
      expect(result).toEqual({ status: "ok" });
      const s = useDawStore.getState();
      expect(s.transcriptReviewCursor).toEqual({
        trackId,
        wordIndex,
        position: i % 3,
      });
      const word = project()
        .transcript!.utterances.flatMap((u) => u.words ?? [])
        .find((w) => w.text === text)!;
      expect(s.playheadSec).toBe(word.timeline_start);
      expect(s.transcriptScrollRequest).toBe(
        presenceAnchor("transcript", "word", trackId, wordIndex),
      );
      expect(s.statusAnnouncement).toBe(
        `Low-confidence word ${(i % 3) + 1} of 3: ${text}`,
      );
    }
  });

  it("prev with no cursor goes to the last stop, and wraps from the first", async () => {
    let result = await execute("transcript.prevLowConfidence", {});
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().transcriptReviewCursor).toEqual({
      trackId: "guest",
      wordIndex: 0,
      position: 2,
    });

    useDawStore.setState({
      transcriptReviewCursor: { trackId: "host", wordIndex: 1, position: 0 },
    });
    result = await execute("transcript.prevLowConfidence", {});
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().transcriptReviewCursor).toEqual({
      trackId: "guest",
      wordIndex: 0,
      position: 2,
    });
  });

  it("turns Annotate on", async () => {
    expect(useDawStore.getState().transcriptAnnotate).toBe(false);
    await execute("transcript.nextLowConfidence", {});
    expect(useDawStore.getState().transcriptAnnotate).toBe(true);
  });

  it("skips a cut-away word by default, but includes it under Annotate + Show cut away", async () => {
    useDawStore.setState({ transcriptAnnotate: true });
    for (let i = 0; i < 3; i++) {
      await execute("transcript.nextLowConfidence", {});
      const cursor = useDawStore.getState().transcriptReviewCursor;
      // The cut-away "cut" word (guest:1) is never a stop without Show cut away.
      expect(cursor).not.toEqual({
        trackId: "guest",
        wordIndex: 1,
        position: i,
      });
    }

    useDawStore.setState({
      transcriptAnnotate: true,
      showCutAwayUtterances: true,
      transcriptReviewCursor: null,
    });
    for (let i = 0; i < 4; i++) {
      await execute("transcript.nextLowConfidence", {});
    }
    const s = useDawStore.getState();
    expect(s.transcriptReviewCursor).toEqual({
      trackId: "guest",
      wordIndex: 1,
      position: 3,
    });
    // The cut-away step does not seek: playhead stays at the previous stop's time.
    expect(s.playheadSec).toBe(3);
    expect(s.transcriptScrollRequest).toBe(
      presenceAnchor("transcript", "word", "guest", 1),
    );
  });

  it("continues from the corrected word's slot", async () => {
    await execute("transcript.nextLowConfidence", {});
    await execute("transcript.nextLowConfidence", {});
    expect(useDawStore.getState().transcriptReviewCursor).toEqual({
      trackId: "host",
      wordIndex: 2,
      position: 1,
    });

    const p = project();
    p.transcript!.utterances[0].words![2].confidence = 1.0;
    useDawStore.setState({ project: p });

    const result = await execute("transcript.nextLowConfidence", {});
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().transcriptReviewCursor).toEqual({
      trackId: "guest",
      wordIndex: 0,
      position: 1,
    });
  });

  it("is disabled with no project", async () => {
    useDawStore.setState({ project: null });
    const result = await execute("transcript.nextLowConfidence", {});
    expect(result).toEqual({ status: "disabled", reason: "No project loaded" });
  });

  it("is disabled with no low-confidence words", async () => {
    const p = project();
    for (const u of p.transcript!.utterances) {
      for (const w of u.words ?? []) w.confidence = 0.9;
    }
    useDawStore.setState({ project: p });
    const result = await execute("transcript.nextLowConfidence", {});
    expect(result).toEqual({
      status: "disabled",
      reason: "No low-confidence words",
    });
    expect(useDawStore.getState().transcriptAnnotate).toBe(false);
    expect(useDawStore.getState().transcriptReviewCursor).toBeNull();
  });
});
