import { act, fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { TranscriptPanel } from "./TranscriptPanel";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

vi.mock("../inspector/views/TranscriptWordInspector", () => ({
  TranscriptWordInspector: ({
    trackId,
    wordIndex,
    embedded,
  }: {
    trackId: string;
    wordIndex: number;
    embedded?: boolean;
  }) => (
    <div data-testid="docked-word-editor">
      {embedded ? "embedded" : "rail"} {trackId}:{wordIndex}
    </div>
  ),
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
          text: "hello there",
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
              text: "there",
              start: 1,
              end: 2,
              timeline_start: 1,
              timeline_end: 2,
              word_index: 1,
              confidence: 0.9,
            },
          ],
        },
      ],
    },
  });
}

describe("TranscriptPanel", () => {
  beforeEach(() => {
    useDawStore.setState({
      project: project(),
      projectPath: "/tmp/ep",
      playheadSec: 0,
      selection: null,
      transcriptFollowPlayhead: false,
      focusMode: "default",
    });
  });

  it("labels Correct instead of Edit", async () => {
    const { container } = render(<TranscriptPanel />);
    expect(
      within(container).getByRole("button", { name: /Correct/i }),
    ).toBeTruthy();
    expect(
      within(container).queryByRole("button", { name: /^Edit$/i }),
    ).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("uses the loading string as Correct aria-label while words are not hydrated", () => {
    const base = project();
    useDawStore.setState({
      project: {
        ...base,
        meta: {
          ...base.meta,
          hydration: { transcript_words: false, history_groups: false },
        },
      },
    });
    const { container } = render(<TranscriptPanel />);
    expect(
      within(container).getByRole("button", {
        name: "Loading transcript words…",
      }),
    ).toBeDisabled();
  });

  it("docks word editor in text focus when Correct selects a word", () => {
    useDawStore.setState({ focusMode: "text" });
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(
      within(container).getByRole("button", { name: /Correct/i }),
    );
    fireEvent.click(within(container).getByRole("button", { name: "hello" }));
    expect(
      within(container).getByTestId("docked-word-editor").textContent,
    ).toContain("embedded host:0");
  });

  it("Select mode builds a transcript range", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(within(container).getByRole("button", { name: /Select/i }));
    fireEvent.click(within(container).getByRole("button", { name: "hello" }));
    fireEvent.click(within(container).getByRole("button", { name: "there" }), {
      shiftKey: true,
    });
    const sel = useDawStore.getState().selection;
    expect(sel?.kind).toBe("transcriptRange");
    if (sel?.kind === "transcriptRange") {
      expect(sel.startWordIndex).toBe(0);
      expect(sel.endWordIndex).toBe(1);
    }
  });

  it("Select mode shift-click extends after mousedown without resetting anchor", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(within(container).getByRole("button", { name: /Select/i }));
    const hello = within(container).getByRole("button", { name: "hello" });
    const there = within(container).getByRole("button", { name: "there" });
    // Real browsers fire mousedown before click; shift must not reset the anchor.
    fireEvent.mouseDown(hello, { button: 0 });
    fireEvent.click(hello);
    fireEvent.mouseDown(there, { button: 0, shiftKey: true });
    fireEvent.click(there, { shiftKey: true });
    const sel = useDawStore.getState().selection;
    expect(sel?.kind).toBe("transcriptRange");
    if (sel?.kind === "transcriptRange") {
      expect(sel.startWordIndex).toBe(0);
      expect(sel.endWordIndex).toBe(1);
    }
  });

  it("Select mode drag keeps the extended range after mouseup click", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(within(container).getByRole("button", { name: /Select/i }));
    const hello = within(container).getByRole("button", { name: "hello" });
    const there = within(container).getByRole("button", { name: "there" });
    fireEvent.mouseDown(hello, { button: 0 });
    fireEvent.mouseEnter(there);
    // Global mouseup clears draggingRef before click (browser order).
    fireEvent.mouseUp(document);
    fireEvent.click(there);
    const sel = useDawStore.getState().selection;
    expect(sel?.kind).toBe("transcriptRange");
    if (sel?.kind === "transcriptRange") {
      expect(sel.startWordIndex).toBe(0);
      expect(sel.endWordIndex).toBe(1);
    }
  });

  it("Annotate shows an edit-boundary mark for every join on transcript tracks", () => {
    useDawStore.setState({
      project: minimalProject({
        timeline_duration_sec: 30,
        clips: {
          clip_count: 3,
          tracks: {
            host: [
              {
                id: "c1",
                track_id: "host",
                source_start: 0,
                source_end: 5,
                timeline_start: 0,
                timeline_end: 5,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
              {
                id: "c2",
                track_id: "host",
                source_start: 8,
                source_end: 12,
                timeline_start: 5,
                timeline_end: 9,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
              {
                id: "c3",
                track_id: "host",
                source_start: 20,
                source_end: 25,
                timeline_start: 9,
                timeline_end: 14,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
            ],
          },
        },
        edit_boundaries: [
          {
            id: "eb:c1:c2",
            track_id: "host",
            left_clip_id: "c1",
            right_clip_id: "c2",
            timeline_join_sec: 5,
            cutaway_source_start: 5,
            cutaway_source_end: 8,
            has_cutaway: true,
            cutaway_word_ids: [],
          },
          {
            id: "eb:c2:c3",
            track_id: "host",
            left_clip_id: "c2",
            right_clip_id: "c3",
            // Join far from any turn *end* — old ±0.2s filter would drop this.
            timeline_join_sec: 9,
            cutaway_source_start: 12,
            cutaway_source_end: 20,
            has_cutaway: true,
            cutaway_word_ids: [],
          },
        ],
        transcript: {
          utterances: [
            {
              track_id: "host",
              speaker: "Host",
              start: 0,
              end: 14,
              text: "alpha bravo charlie",
              mappable: true,
              timeline_start: 0,
              timeline_end: 14,
              words: [
                {
                  text: "alpha",
                  start: 0,
                  end: 4,
                  timeline_start: 0,
                  timeline_end: 4,
                  word_index: 0,
                  confidence: 0.9,
                },
                {
                  text: "bravo",
                  start: 4,
                  end: 8,
                  timeline_start: 4,
                  timeline_end: 8,
                  word_index: 1,
                  confidence: 0.9,
                },
                {
                  text: "charlie",
                  start: 8,
                  end: 14,
                  timeline_start: 8,
                  timeline_end: 14,
                  word_index: 2,
                  confidence: 0.9,
                },
              ],
            },
          ],
        },
      }),
      transcriptAnnotate: false,
    });
    const { container } = render(<TranscriptPanel />);
    expect(container.querySelectorAll(".edit-boundary-mark")).toHaveLength(0);
    fireEvent.click(
      within(container).getByRole("button", { name: /Annotate/i }),
    );
    const marks = container.querySelectorAll(".edit-boundary-mark");
    expect(marks).toHaveLength(2);
    expect(
      [...marks]
        .map((m) => m.getAttribute("data-boundary-id"))
        .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["eb:c1:c2", "eb:c2:c3"]);
  });

  it("anchors turns and words for presence", () => {
    const { container } = render(<TranscriptPanel />);
    expect(
      container.querySelector('[data-presence-anchor="transcript:turn:0"]'),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-presence-anchor="transcript:word:host:0"]',
      ),
    ).toBeTruthy();
  });

  it("scrolls to a follow request without unlocking playhead follow", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:0");
    });
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(true);
    expect(useDawStore.getState().transcriptScrollRequest).toBeNull();
  });

  it("unfollows on manual transcript scroll", () => {
    useDawStore.setState({ followingClientId: "a" });
    const { container } = render(<TranscriptPanel />);
    const list = container.querySelector(".transcript-list");
    expect(list).toBeTruthy();
    fireEvent.scroll(list!);
    expect(useDawStore.getState().followingClientId).toBeNull();
  });
});
