import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { TranscriptWordInspector } from "./TranscriptWordInspector";

vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  correctTranscriptWord: vi.fn(async () => {}),
  correctTranscriptPhrase: vi.fn(async () => {}),
  setTranscriptWordSuppressed: vi.fn(async () => {}),
  setTranscriptWordsIgnored: vi.fn(async () => {}),
  refreshProject: vi.fn(),
}));

vi.mock("../../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

import {
  correctTranscriptPhrase,
  correctTranscriptWord,
  setTranscriptWordSuppressed,
  setTranscriptWordsIgnored,
} from "../../api";

function project() {
  return minimalProject({
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

describe("TranscriptWordInspector", () => {
  beforeEach(() => {
    vi.mocked(correctTranscriptWord).mockClear();
    vi.mocked(correctTranscriptPhrase).mockClear();
    vi.mocked(setTranscriptWordsIgnored).mockClear();
    vi.mocked(setTranscriptWordSuppressed).mockClear();
    useDawStore.setState({
      project: project(),
      projectPath: "/tmp/ep",
      transcriptInlineEditFailure: null,
    });
  });

  it("shows the timing note for a host", () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    expect(
      screen.getByText(/audio and word timing stay as recorded/),
    ).toBeInTheDocument();
  });

  it("hides the timing note for a guest", () => {
    useDawStore.setState({ projectPath: "share:tok" });
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    expect(
      screen.queryByText(/audio and word timing stay as recorded/),
    ).toBeNull();
  });

  it("Apply with end index = start calls correctTranscriptWord", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptWord).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        "Hello",
      );
    });
    expect(correctTranscriptPhrase).not.toHaveBeenCalled();
  });

  it("Apply with end index > start calls correctTranscriptPhrase", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        1,
        "Hello there",
      );
    });
  });

  it("Ignore calls setTranscriptWordsIgnored(i, i, true)", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordsIgnored).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        0,
        true,
      );
    });
  });

  it("Restore calls setTranscriptWordsIgnored(i, i, false) for an ignored word", async () => {
    const withIgnored = project();
    withIgnored.transcript!.utterances[0].words![0].ignored = true;
    useDawStore.setState({ project: withIgnored, projectPath: "/tmp/ep" });
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toHaveAttribute(
      "title",
      expect.stringMatching(/^Restore:/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordsIgnored).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        0,
        false,
      );
    });
  });

  it("marks which action changes audio", () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    const suppress = screen.getByRole("button", { name: "Suppress" });
    expect(suppress).toHaveAttribute(
      "title",
      expect.stringMatching(/audio is unchanged/),
    );
    expect(suppress.className).not.toMatch(/\bprimary\b/);
    const ignore = screen.getByRole("button", { name: "Ignore" });
    expect(ignore.className).toMatch(/\bprimary\b/);
    expect(ignore).toHaveAttribute(
      "title",
      expect.stringMatching(/^Ignore:.*mute/),
    );
  });

  it("shows an error for empty text", () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Text cannot be empty")).toBeInTheDocument();
    expect(correctTranscriptWord).not.toHaveBeenCalled();
  });

  it("sends a failure that settles after the selection moved to the late-failure banner, not the next word (#634)", async () => {
    let reject!: (e: Error) => void;
    vi.mocked(setTranscriptWordSuppressed).mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const { rerender } = render(
      <TranscriptWordInspector key="host:0" trackId="host" wordIndex={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    rerender(
      <TranscriptWordInspector key="host:1" trackId="host" wordIndex={1} />,
    );
    expect(screen.getByRole("button", { name: "Suppress" })).toBeEnabled();
    await act(async () => {
      reject(new Error("boom"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useDawStore.getState().transcriptInlineEditFailure).toEqual({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      originalText: "hello",
      flag: { name: "suppressed", was: false },
      message: "Could not update “hello”: boom",
    });
  });

  it("shows a failure under the same word while it is still open", async () => {
    vi.mocked(setTranscriptWordSuppressed).mockRejectedValueOnce(
      new Error("boom"),
    );
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
  });
});
