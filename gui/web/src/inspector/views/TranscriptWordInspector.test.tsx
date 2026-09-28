import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import { ApiError } from "../../utils/apiError";
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

/** `project()` plus a second listing of word 1 that disagrees ("where"). */
function projectWithDisagreeingDuplicate() {
  const dup = project();
  dup.transcript!.utterances.push({
    track_id: "host",
    speaker: "Host",
    start: 2,
    end: 3,
    text: "where",
    mappable: true,
    timeline_start: 2,
    timeline_end: 3,
    words: [
      {
        text: "where",
        start: 2,
        end: 3,
        timeline_start: 2,
        timeline_end: 3,
        word_index: 1,
        confidence: 0.9,
      },
    ],
  });
  return dup;
}

/** `project()` with word 1 already suppressed, still listed in its utterance
 * (as the mapper places a suppressed chip's run inside an utterance window). */
function projectWithSuppressedWord() {
  const p = project();
  p.transcript!.utterances[0].words![1].suppressed = true;
  return p;
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
    expect(
      screen.queryByText(/can't check whether someone else changed/),
    ).toBeNull();
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
        "hello",
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
    expect(
      screen.queryByText(/can't check whether someone else changed/),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        1,
        "Hello there",
        "hello there",
      );
    });
  });

  it("Apply sends the span text seen before a peer changed an inner word", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "1" },
    });
    const changed = project();
    changed.transcript!.utterances[0]!.words![1]!.text = "where";
    act(() => {
      useDawStore.setState({ project: changed });
    });
    expect(screen.getByLabelText("Corrected text")).toHaveValue("Hello there");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        1,
        "Hello there",
        "hello there",
      );
    });
  });

  it("Apply with an end index past the loaded words sends null expected text", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "5" },
    });
    expect(
      screen.getByText(/can't check whether someone else changed/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        5,
        "Hello there",
        null,
      );
    });
  });

  it("phrase Apply with a duplicated index that disagrees sends null expected text", async () => {
    useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "1" },
    });
    expect(
      screen.getByText(/can't check whether someone else changed/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        1,
        "Hello there",
        null,
      );
    });
  });

  it("single-word Apply on a duplicated index that disagrees sends null expected text", async () => {
    useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    render(<TranscriptWordInspector trackId="host" wordIndex={1} />);
    expect(
      screen.getByText(/can't check whether someone else changed/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "There" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptWord).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        "There",
        null,
      );
    });
    expect(correctTranscriptPhrase).not.toHaveBeenCalled();
  });

  it("Ignore calls setTranscriptWordsIgnored(i, i, true) with the displayed text", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordsIgnored).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        0,
        true,
        "hello",
      );
    });
  });

  it("Restore calls setTranscriptWordsIgnored(i, i, false) with the displayed text for an ignored word", async () => {
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
        "hello",
      );
    });
  });

  it("Suppress calls setTranscriptWordSuppressed with the displayed text", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        true,
        "there",
      );
    });
  });

  it("Suppress sends null expected text for a duplicated index that disagrees", async () => {
    useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    render(<TranscriptWordInspector trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        true,
        null,
      );
    });
  });

  it("Unsuppress calls setTranscriptWordSuppressed with the displayed text", async () => {
    useDawStore.setState({ project: projectWithSuppressedWord() });
    render(<TranscriptWordInspector trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Unsuppress" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        false,
        "there",
      );
    });
  });

  it("Ignore sends null expected text for a duplicated index that disagrees", async () => {
    useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    render(<TranscriptWordInspector trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordsIgnored).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        1,
        true,
        null,
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

  it("records a late Ignore failure under the ignored flag (#634)", async () => {
    let reject!: (e: Error) => void;
    vi.mocked(setTranscriptWordsIgnored).mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const { rerender } = render(
      <TranscriptWordInspector key="host:0" trackId="host" wordIndex={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    rerender(
      <TranscriptWordInspector key="host:1" trackId="host" wordIndex={1} />,
    );
    await act(async () => {
      reject(new Error("boom"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useDawStore.getState().transcriptInlineEditFailure).toEqual({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      originalText: "hello",
      flag: { name: "ignored", was: false },
      message: "Could not update “hello”: boom",
    });
  });

  it("records a late Apply failure as a text fix with no flag (#634)", async () => {
    let reject!: (e: Error) => void;
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const { rerender } = render(
      <TranscriptWordInspector key="host:0" trackId="host" wordIndex={0} />,
    );
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
    rerender(
      <TranscriptWordInspector key="host:1" trackId="host" wordIndex={1} />,
    );
    await act(async () => {
      reject(new Error("boom"));
    });
    const failure = useDawStore.getState().transcriptInlineEditFailure;
    expect(failure).toEqual({
      projectPath: "/tmp/ep",
      trackId: "host",
      wordIndex: 0,
      originalText: "hello",
      message: "Could not fix “hello”: boom",
    });
    expect(failure).not.toHaveProperty("flag");
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

  it("a phrase draft and its baseline survive a peer edit of the anchor word (#746)", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "1" },
    });
    const peerEdited = project();
    peerEdited.transcript!.utterances[0]!.words![0]!.text = "Howdy";
    act(() => {
      useDawStore.setState({ project: peerEdited });
    });
    expect(screen.getByLabelText("Corrected text")).toHaveValue("Hello there");
    expect(screen.getByLabelText("End word index")).toHaveValue(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        1,
        "Hello there",
        "hello there",
      );
    });
  });

  it("a single-word draft and its baseline survive a peer edit of the anchor word (#746)", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hiya" },
    });
    const peerEdited = project();
    peerEdited.transcript!.utterances[0]!.words![0]!.text = "Howdy";
    act(() => {
      useDawStore.setState({ project: peerEdited });
    });
    expect(screen.getByLabelText("Corrected text")).toHaveValue("Hiya");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptWord).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        "Hiya",
        "hello",
      );
    });
  });

  it("a second single-word Apply sends the first Apply's text (#746)", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(correctTranscriptWord).toHaveBeenNthCalledWith(
      1,
      "/tmp/ep",
      "host",
      0,
      "Hello",
      "hello",
    );
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "World" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(correctTranscriptWord).toHaveBeenNthCalledWith(
      2,
      "/tmp/ep",
      "host",
      0,
      "World",
      "Hello",
    );
  });

  it("a phrase Apply that adds a word moves End index to 2 and the baseline to the new text (#746)", async () => {
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there new" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenNthCalledWith(
        1,
        "/tmp/ep",
        "host",
        0,
        1,
        "Hello there new",
        "hello there",
      );
    });
    await vi.waitFor(() => {
      expect(screen.getByLabelText("End word index")).toHaveValue(2);
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenNthCalledWith(
        2,
        "/tmp/ep",
        "host",
        0,
        2,
        "Hello there new",
        "Hello there new",
      );
    });
  });

  it('after a 409, the second Apply sends the store\'s new span text ("hello where") (#746)', async () => {
    let reject!: (e: Error) => void;
    vi.mocked(correctTranscriptPhrase).mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() =>
      expect(correctTranscriptPhrase).toHaveBeenCalledTimes(1),
    );
    const peerEdited = project();
    peerEdited.transcript!.utterances[0]!.words![1]!.text = "where";
    act(() => {
      useDawStore.setState({ project: peerEdited });
    });
    await act(async () => {
      reject(new ApiError("stale", null, 409));
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptPhrase).toHaveBeenNthCalledWith(
        2,
        "/tmp/ep",
        "host",
        0,
        1,
        "Hello there",
        "hello where",
      );
    });
  });

  it("a non-409 failure keeps the baseline (#746)", async () => {
    vi.mocked(correctTranscriptWord).mockRejectedValueOnce(
      new ApiError("boom", null, 500),
    );
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(screen.getByLabelText("Corrected text")).toHaveValue("Hello");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(correctTranscriptWord).toHaveBeenLastCalledWith(
        "/tmp/ep",
        "host",
        0,
        "Hello",
        "hello",
      );
    });
  });

  it("the draft seeds once the words finish hydrating (#746)", () => {
    const notHydrated = project();
    notHydrated.meta = {
      ...notHydrated.meta,
      hydration: { transcript_words: false },
    };
    useDawStore.setState({ project: notHydrated, projectPath: "/tmp/ep" });
    render(<TranscriptWordInspector trackId="host" wordIndex={0} />);
    expect(screen.getByText("Loading transcript words…")).toBeInTheDocument();
    act(() => {
      useDawStore.setState({ project: project() });
    });
    expect(screen.getByLabelText("Corrected text")).toHaveValue("hello");
  });

  it("gives the unverified-span hint role=status and describes the End index input only while it shows", async () => {
    const { container } = render(
      <TranscriptWordInspector trackId="host" wordIndex={0} />,
    );
    const endInput = screen.getByLabelText("End word index");
    expect(endInput).not.toHaveAttribute("aria-describedby");
    fireEvent.change(endInput, { target: { value: "5" } });
    const hint = screen.getByText(/can't check whether someone else changed/);
    expect(hint).toHaveAttribute("role", "status");
    expect(endInput).toHaveAttribute("aria-describedby", hint.id);
    fireEvent.change(endInput, { target: { value: "0" } });
    expect(endInput).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText(/can't check whether someone else changed/),
    ).toBeNull();
    await expectNoA11yViolations(container);
  });
});
