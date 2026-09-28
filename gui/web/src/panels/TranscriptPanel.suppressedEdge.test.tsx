import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshProject, setTranscriptWordSuppressed } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { TranscriptWordView } from "../types/project";
import type { ProsodyOverlay } from "../types/prosody";
import { TranscriptPanel } from "./TranscriptPanel";

// Real TranscriptWordInspector renders here (unlike TranscriptPanel.test.tsx, which
// mocks it) so Correct -> select chip -> Unsuppress exercises the actual round trip
// for a word the mapper attached outside its utterance's own [start, end) window (#752).

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  setTranscriptWordSuppressed: vi.fn(async () => ({})),
  refreshProject: vi.fn(async () => minimalProject()),
}));

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

const useProsodyOverlayMock = vi.hoisted(() =>
  vi.fn((_enabled: boolean): ProsodyOverlay | null => null),
);
vi.mock("../prosody/useProsodyOverlay", () => ({
  useProsodyOverlay: useProsodyOverlayMock,
}));

type EdgeCase = {
  name: string;
  words: TranscriptWordView[];
  utteranceStart: number;
  utteranceEnd: number;
  utteranceText: string;
  targetWordIndex: number;
  targetText: string;
};

const FIRST_WORD_SUPPRESSED: EdgeCase = {
  name: "a suppressed first word",
  utteranceStart: 0.5,
  utteranceEnd: 1.1,
  utteranceText: "to the show",
  targetWordIndex: 0,
  targetText: "welcome",
  words: [
    {
      text: "welcome",
      start: 0,
      end: 0.3,
      timeline_start: 0,
      timeline_end: 0.3,
      word_index: 0,
      confidence: 0.9,
      suppressed: true,
    },
    {
      text: "to",
      start: 0.5,
      end: 0.7,
      timeline_start: 0.5,
      timeline_end: 0.7,
      word_index: 1,
      confidence: 0.9,
    },
    {
      text: "the",
      start: 0.7,
      end: 0.9,
      timeline_start: 0.7,
      timeline_end: 0.9,
      word_index: 2,
      confidence: 0.9,
    },
    {
      text: "show",
      start: 0.9,
      end: 1.1,
      timeline_start: 0.9,
      timeline_end: 1.1,
      word_index: 3,
      confidence: 0.9,
    },
  ],
};

const LAST_WORD_SUPPRESSED: EdgeCase = {
  name: "a suppressed last word",
  utteranceStart: 0,
  utteranceEnd: 0.6,
  utteranceText: "hello world",
  targetWordIndex: 2,
  targetText: "done",
  words: [
    {
      text: "hello",
      start: 0,
      end: 0.3,
      timeline_start: 0,
      timeline_end: 0.3,
      word_index: 0,
      confidence: 0.9,
    },
    {
      text: "world",
      start: 0.4,
      end: 0.6,
      timeline_start: 0.4,
      timeline_end: 0.6,
      word_index: 1,
      confidence: 0.9,
    },
    {
      text: "done",
      start: 0.7,
      end: 0.9,
      timeline_start: 0.7,
      timeline_end: 0.9,
      word_index: 2,
      confidence: 0.9,
      suppressed: true,
    },
  ],
};

function projectFor(edgeCase: EdgeCase) {
  return minimalProject({
    timeline_duration_sec: 10,
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: edgeCase.utteranceStart,
          end: edgeCase.utteranceEnd,
          text: edgeCase.utteranceText,
          mappable: true,
          timeline_start: edgeCase.utteranceStart,
          timeline_end: edgeCase.utteranceEnd,
          words: edgeCase.words,
        },
      ],
    },
  });
}

describe("TranscriptPanel suppressed edge words (#752)", () => {
  beforeEach(() => {
    vi.mocked(setTranscriptWordSuppressed).mockClear();
    vi.mocked(refreshProject).mockClear();
    useDawStore.setState({
      project: minimalProject(),
      projectPath: "/tmp/ep",
      playheadSec: 0,
      selection: null,
      transcriptFollowPlayhead: false,
      layoutMode: "text",
      pointerKind: "fine",
      transcriptInlineCommitPending: false,
      transcriptInlineEditFailure: null,
      transcriptAnnotate: false,
      transcriptReviewCursor: null,
    });
  });

  it.each([FIRST_WORD_SUPPRESSED, LAST_WORD_SUPPRESSED])(
    "keeps $name as a chip, and Correct -> select -> Unsuppress round-trips it",
    async (edgeCase) => {
      useDawStore.setState({ project: projectFor(edgeCase) });
      const { container } = render(<TranscriptPanel />);

      const chip = container.querySelector(".utterance-word.suppressed");
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toBe(edgeCase.targetText);

      fireEvent.click(
        within(container).getByRole("button", { name: /Correct/i }),
      );
      fireEvent.click(
        within(container).getByRole("button", { name: edgeCase.targetText }),
      );

      expect(useDawStore.getState().selection).toEqual({
        kind: "transcriptWord",
        trackId: "host",
        wordIndex: edgeCase.targetWordIndex,
      });

      const unsuppress = await within(container).findByRole("button", {
        name: "Unsuppress",
      });
      fireEvent.click(unsuppress);

      expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        edgeCase.targetWordIndex,
        false,
        edgeCase.targetText,
      );

      await expectNoA11yViolations(container);
    },
  );
});
