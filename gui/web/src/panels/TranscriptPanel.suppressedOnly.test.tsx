import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshProject, setTranscriptWordSuppressed } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { TranscriptPanel } from "./TranscriptPanel";

// Real TranscriptWordInspector renders here (unlike TranscriptPanel.test.tsx, which
// mocks it) so Correct -> select chip -> Unsuppress exercises the actual round trip
// against a view-only suppressed_only row (#758).

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  setTranscriptWordSuppressed: vi.fn(async () => ({})),
  refreshProject: vi.fn(async () => minimalProject()),
}));

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

vi.mock("../prosody/useProsodyOverlay", () => ({
  useProsodyOverlay: vi.fn(() => null),
}));

function project() {
  return minimalProject({
    timeline_duration_sec: 10,
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: 2,
          text: "hello world",
          mappable: true,
          timeline_start: 0,
          timeline_end: 2,
          words: [
            {
              text: "hello",
              start: 0,
              end: 1,
              timeline_start: 0,
              timeline_end: 1,
              word_index: 0,
              confidence: 0.9,
            },
            {
              text: "world",
              start: 1,
              end: 2,
              timeline_start: 1,
              timeline_end: 2,
              word_index: 1,
              confidence: 0.9,
            },
          ],
        },
        {
          track_id: "guest",
          speaker: "guest",
          start: 0.1,
          end: 0.6,
          text: "um uh",
          suppressed_only: true,
          mappable: true,
          timeline_start: 0.1,
          timeline_end: 0.6,
          words: [
            {
              text: "um",
              start: 0.1,
              end: 0.3,
              timeline_start: 0.1,
              timeline_end: 0.3,
              word_index: 0,
              confidence: 0.4,
              suppressed: true,
            },
            {
              text: "uh",
              start: 0.4,
              end: 0.6,
              timeline_start: 0.4,
              timeline_end: 0.6,
              word_index: 1,
              confidence: 0.4,
              suppressed: true,
            },
          ],
        },
      ],
    },
  });
}

describe("TranscriptPanel suppressed-only rows (#758)", () => {
  beforeEach(() => {
    vi.mocked(setTranscriptWordSuppressed).mockClear();
    vi.mocked(refreshProject).mockClear();
    useDawStore.setState({
      project: project(),
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

  it("dims the suppressed-only row, notes it, and round-trips Correct -> Unsuppress", async () => {
    const { container } = render(<TranscriptPanel />);

    const seg = container.querySelector(".utterance-seg.suppressed-only");
    expect(seg).not.toBeNull();
    const chips = within(seg as HTMLElement).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["um", "uh"]);
    expect(container.querySelector(".utterance-note")?.textContent).toContain(
      "all suppressed",
    );

    fireEvent.click(
      within(container).getByRole("button", { name: /Correct/i }),
    );
    fireEvent.click(within(container).getByRole("button", { name: "um" }));

    expect(useDawStore.getState().selection).toEqual({
      kind: "transcriptWord",
      trackId: "guest",
      wordIndex: 0,
    });

    const unsuppress = await within(container).findByRole("button", {
      name: "Unsuppress",
    });
    fireEvent.click(unsuppress);

    expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
      "/tmp/ep",
      "guest",
      0,
      false,
      "um",
    );

    await expectNoA11yViolations(container);
  });

  it("excludes the suppressed-only row from the utterance count and low-confidence review", () => {
    useDawStore.setState({ transcriptAnnotate: true });
    const { container } = render(<TranscriptPanel />);

    expect(
      within(container).getByText("1 utterances", { exact: false }),
    ).toBeInTheDocument();
    expect(
      within(container).queryByRole("group", {
        name: "Low-confidence review",
      }),
    ).toBeNull();
    expect(container.querySelector(".low-confidence")).toBeNull();
  });

  it("never marks the suppressed-only row active, even under the playhead", () => {
    useDawStore.setState({ playheadSec: 0.15 });
    const { container } = render(<TranscriptPanel />);

    const seg = container.querySelector(".utterance-seg.suppressed-only");
    expect(seg).not.toBeNull();
    expect(seg).not.toHaveClass("active");
    expect(seg?.querySelector(".utterance-word.active")).toBeNull();
  });
});
