import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import { ApiError } from "../../utils/apiError";
import { wordSelection } from "../../utils/rangeSelect";
import { focusFirstControl } from "./inspectorFocus";
import { useSelectionSections } from "./selectionSections";

function Word({
  trackId,
  sourceId = null,
  wordIndex,
}: {
  trackId: string;
  sourceId?: string | null;
  wordIndex: number;
}) {
  const sections = useSelectionSections(
    wordSelection({ trackId, sourceId, wordIndex }),
  );
  return (
    <div>
      <div tabIndex={-1} data-inspector-anchor data-testid="anchor" />
      {sections?.flatMap((section) =>
        section.rows.map((row) => (
          <div key={`${section.id}:${row.id}`}>{row.control}</div>
        )),
      )}
    </div>
  );
}

vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  correctTranscriptWord: vi.fn(async () => {}),
  correctTranscriptPhrase: vi.fn(async () => {}),
  setTranscriptWordSuppressed: vi.fn(async () => {}),
  setTranscriptWordAutomatic: vi.fn(async () => {}),
  setTranscriptWordsIgnored: vi.fn(async () => {}),
}));

vi.mock("../../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

import {
  correctTranscriptPhrase,
  correctTranscriptWord,
  setTranscriptWordAutomatic,
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

/** `project()` whose host words 0.. read `texts`, as the store holds them once `applyDocumentResult` lands a correction. */
function projectWithWords(texts: string[]) {
  const next = project();
  const utterance = next.transcript!.utterances[0]!;
  utterance.text = texts.join(" ");
  utterance.end = texts.length;
  utterance.timeline_end = texts.length;
  utterance.words = texts.map((text, i) => ({
    text,
    start: i,
    end: i + 1,
    timeline_start: i,
    timeline_end: i + 1,
    word_index: i,
    confidence: 0.9,
  }));
  return next;
}

/** A correction mock that succeeds and leaves the store reading `texts`. */
function applyingWords(texts: string[]) {
  return async () => {
    useDawStore.setState({ project: projectWithWords(texts) });
    return null;
  };
}

/** `project()` with word 1 already suppressed, still listed in its utterance
 * (as the mapper places a suppressed chip's run inside an utterance window). */
function projectWithSuppressedWord() {
  const p = project();
  p.transcript!.utterances[0].words![1].suppressed = true;
  return p;
}

/** `project()` with word 1 suppressed and locked (#768/#781): a person or
 * agent set `suppressed` directly, not a heuristic pass. */
function projectWithLockedWord() {
  const p = project();
  p.transcript!.utterances[0].words![1].suppressed = true;
  p.transcript!.utterances[0].words![1].audibility_locked = true;
  return p;
}

describe("word sections", () => {
  beforeEach(() => {
    vi.mocked(correctTranscriptWord).mockClear();
    vi.mocked(correctTranscriptPhrase).mockClear();
    vi.mocked(setTranscriptWordsIgnored).mockClear();
    vi.mocked(setTranscriptWordSuppressed).mockClear();
    vi.mocked(setTranscriptWordAutomatic).mockClear();
    useDawStore.setState({
      project: project(),
      projectPath: "/tmp/ep",
      transcriptInlineEditFailure: null,
      selection: null,
      wordDraft: null,
    });
  });

  describe("typed draft across shell changes (#1885)", () => {
    const target = { trackId: "host", sourceId: null, wordIndex: 0 };
    const field = () => screen.getByLabelText("Corrected text");

    beforeEach(() => {
      useDawStore.setState({
        selection: wordSelection(target),
        wordDraft: null,
        projectEpoch: 1,
      });
    });

    it.each(["phone portrait to phone landscape", "tablet to phone"])(
      "keeps the typed text and End index through %s",
      () => {
        const first = render(<Word trackId="host" wordIndex={0} />);
        fireEvent.change(field(), { target: { value: "howdy" } });
        fireEvent.change(screen.getByLabelText("End word index"), {
          target: { value: "1" },
        });
        first.unmount();
        render(<Word trackId="host" wordIndex={0} />);
        expect(field()).toHaveValue("howdy");
        expect(screen.getByLabelText("End word index")).toHaveValue(1);
      },
    );

    it("sends the span text it was checked against, not a fresh read", async () => {
      const first = render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(screen.getByLabelText("End word index"), {
        target: { value: "1" },
      });
      fireEvent.change(field(), { target: { value: "hi you" } });
      first.unmount();
      useDawStore.setState({ project: projectWithWords(["hello", "friend"]) });
      render(<Word trackId="host" wordIndex={0} />);
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await act(async () => {});
      expect(correctTranscriptPhrase).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        1,
        "hi you",
        "hello there",
      );
    });

    it("shows the saved text when nothing was typed", () => {
      const first = render(<Word trackId="host" wordIndex={0} />);
      first.unmount();
      render(<Word trackId="host" wordIndex={0} />);
      expect(field()).toHaveValue("hello");
      expect(useDawStore.getState().wordDraft).toBeNull();
    });

    it("drops the draft when the selection moves to another word", () => {
      const first = render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(field(), { target: { value: "howdy" } });
      expect(useDawStore.getState().wordDraft?.text).toBe("howdy");
      first.unmount();
      act(() => {
        useDawStore.setState({
          selection: wordSelection({ ...target, wordIndex: 1 }),
        });
      });
      expect(useDawStore.getState().wordDraft).toBeNull();
      act(() => {
        useDawStore.setState({ selection: wordSelection(target) });
      });
      render(<Word trackId="host" wordIndex={0} />);
      expect(field()).toHaveValue("hello");
    });

    it("drops the draft when the selection is cleared", () => {
      render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(field(), { target: { value: "howdy" } });
      act(() => {
        useDawStore.setState({ selection: null });
      });
      expect(useDawStore.getState().wordDraft).toBeNull();
    });

    it("does not carry a draft into another project", () => {
      const first = render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(field(), { target: { value: "howdy" } });
      first.unmount();
      act(() => {
        useDawStore.setState({ projectEpoch: 2 });
      });
      expect(useDawStore.getState().wordDraft).toBeNull();
      render(<Word trackId="host" wordIndex={0} />);
      expect(field()).toHaveValue("hello");
    });

    it("clears the draft once Apply saves it", async () => {
      vi.mocked(correctTranscriptWord).mockImplementationOnce(
        applyingWords(["howdy", "there"]),
      );
      render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(field(), { target: { value: "howdy" } });
      expect(useDawStore.getState().wordDraft).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await act(async () => {});
      expect(useDawStore.getState().wordDraft).toBeNull();
    });

    it("an editor nobody typed in does not turn a changed saved word into a draft", () => {
      // The text layout keeps the side-rail editor mounted but hidden beside
      // the docked one, so an untouched instance sees the other's Apply (or a
      // peer's edit) as a word that moved under it.
      const first = render(<Word trackId="host" wordIndex={0} />);
      act(() => {
        useDawStore.setState({ project: projectWithWords(["howdy", "there"]) });
      });
      expect(useDawStore.getState().wordDraft).toBeNull();
      first.unmount();
      render(<Word trackId="host" wordIndex={0} />);
      expect(field()).toHaveValue("howdy");
    });

    it("an editor that typed and settled does not write a draft when the word later moves", () => {
      render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(field(), { target: { value: "howdy" } });
      fireEvent.change(field(), { target: { value: "hello" } });
      expect(useDawStore.getState().wordDraft).toBeNull();
      act(() => {
        useDawStore.setState({
          project: projectWithWords(["bonjour", "there"]),
        });
      });
      expect(useDawStore.getState().wordDraft).toBeNull();
    });

    it("a restored editor does not write or clear the slot until the person edits it", () => {
      const first = render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(field(), { target: { value: "howdy" } });
      first.unmount();
      render(<Word trackId="host" wordIndex={0} />);
      expect(field()).toHaveValue("howdy");
      // A peer's edit lands on the saved word; the restored, unedited editor
      // must leave the person's slot as it was.
      act(() => {
        useDawStore.setState({ project: projectWithWords(["howdy", "there"]) });
      });
      expect(useDawStore.getState().wordDraft?.text).toBe("howdy");
      fireEvent.change(field(), { target: { value: "howdy!" } });
      expect(useDawStore.getState().wordDraft?.text).toBe("howdy!");
    });

    it("drops a draft typed back to the saved text", () => {
      render(<Word trackId="host" wordIndex={0} />);
      fireEvent.change(field(), { target: { value: "howdy" } });
      fireEvent.change(field(), { target: { value: "hello" } });
      expect(useDawStore.getState().wordDraft).toBeNull();
    });
  });

  it("shows the timing note for a host", () => {
    render(<Word trackId="host" wordIndex={0} />);
    expect(
      screen.getByText(/audio and word timing stay as recorded/),
    ).toBeInTheDocument();
  });

  it("hides the timing note for a guest", () => {
    useDawStore.setState({ projectPath: "share:tok" });
    render(<Word trackId="host" wordIndex={0} />);
    expect(
      screen.queryByText(/audio and word timing stay as recorded/),
    ).toBeNull();
  });

  it("shows the lock state and its explanation next to Suppressed for a locked word (#813)", () => {
    useDawStore.setState({ project: projectWithLockedWord() });
    render(<Word trackId="host" wordIndex={1} />);
    expect(screen.getByText("Suppressed").nextSibling).toHaveTextContent(
      "yes (locked)",
    );
    expect(
      screen.getByText(
        /Suppression locked: set directly, not by a heuristic pass\. Reconcile and auto-suppress leave it alone\./,
      ),
    ).toBeInTheDocument();
  });

  it("hides the lock explanation for a word that is not locked", () => {
    render(<Word trackId="host" wordIndex={1} />);
    expect(screen.getByText("Suppressed").nextSibling).toHaveTextContent("no");
    expect(screen.queryByText(/Suppression locked/)).not.toBeInTheDocument();
  });

  it("the locked word inspector state is axe-clean (#813)", async () => {
    useDawStore.setState({ project: projectWithLockedWord() });
    const { container } = render(<Word trackId="host" wordIndex={1} />);
    await expectNoA11yViolations(container);
  });

  it("hides Return to automatic for a word that is not locked", () => {
    render(<Word trackId="host" wordIndex={1} />);
    expect(
      screen.queryByRole("button", { name: "Return to automatic" }),
    ).not.toBeInTheDocument();
  });

  it("shows Return to automatic for a locked word (#824)", () => {
    useDawStore.setState({ project: projectWithLockedWord() });
    render(<Word trackId="host" wordIndex={1} />);
    expect(
      screen.getByRole("button", { name: "Return to automatic" }),
    ).toBeInTheDocument();
  });

  it("hides Return to automatic for a guest even on a locked word", () => {
    useDawStore.setState({
      project: projectWithLockedWord(),
      projectPath: "share:tok",
    });
    render(<Word trackId="host" wordIndex={1} />);
    expect(
      screen.queryByRole("button", { name: "Return to automatic" }),
    ).not.toBeInTheDocument();
  });

  it("Return to automatic calls setTranscriptWordAutomatic with the displayed text (#824)", async () => {
    useDawStore.setState({ project: projectWithLockedWord() });
    render(<Word trackId="host" wordIndex={1} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Return to automatic" }),
    );
    await vi.waitFor(() => {
      expect(setTranscriptWordAutomatic).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        "there",
        null,
      );
    });
  });

  it("moves focus to the sheet anchor when Return to automatic disappears", async () => {
    useDawStore.setState({ project: projectWithLockedWord() });
    vi.mocked(setTranscriptWordAutomatic).mockImplementationOnce(async () => {
      useDawStore.setState({ project: projectWithSuppressedWord() });
      return null;
    });
    render(<Word trackId="host" wordIndex={1} />);
    const button = screen.getByRole("button", { name: "Return to automatic" });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(
      screen.queryByRole("button", { name: "Return to automatic" }),
    ).toBeNull();
    expect(screen.getByTestId("anchor")).toHaveFocus();
    expect(screen.getByText("Suppressed").nextSibling).toHaveTextContent("yes");
  });

  it("records a detached unlock failure under the lock flag", async () => {
    useDawStore.setState({ project: projectWithLockedWord() });
    let reject: (error: Error) => void = () => {
      throw new Error("request not started");
    };
    vi.mocked(setTranscriptWordAutomatic).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const { rerender } = render(
      <Word key="host:1" trackId="host" wordIndex={1} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Return to automatic" }),
    );
    rerender(<Word key="host:0" trackId="host" wordIndex={0} />);
    await act(async () => {
      reject(new Error("unlock failed"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useDawStore.getState().transcriptInlineEditFailure).toEqual({
      projectPath: "/tmp/ep",
      trackId: "host",
      sourceId: null,
      wordIndex: 1,
      originalText: "there",
      flag: { name: "audibility_locked", was: true },
      message: "Could not update “there”: unlock failed",
    });
  });

  it("Apply with end index = start calls correctTranscriptWord", async () => {
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={1} />);
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
    render(<Word trackId="host" wordIndex={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordsIgnored).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        0,
        true,
        "hello",
        null,
      );
    });
  });

  it("Restore calls setTranscriptWordsIgnored(i, i, false) with the displayed text for an ignored word", async () => {
    const withIgnored = project();
    withIgnored.transcript!.utterances[0].words![0].ignored = true;
    useDawStore.setState({ project: withIgnored, projectPath: "/tmp/ep" });
    render(<Word trackId="host" wordIndex={0} />);
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
        null,
      );
    });
  });

  it("Suppress calls setTranscriptWordSuppressed with the displayed text", async () => {
    render(<Word trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        true,
        "there",
        null,
      );
    });
  });

  it("Suppress answers with a toast whose Undo names the history entry it left", async () => {
    vi.mocked(setTranscriptWordSuppressed).mockResolvedValueOnce(
      "h-suppress" as never,
    );
    render(<Word trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    await vi.waitFor(() => {
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: "Word dropped from the transcript text",
        undo: "h-suppress",
      });
    });
  });

  it("Apply answers with a toast and Undo for a word fix", async () => {
    vi.mocked(correctTranscriptWord).mockResolvedValueOnce("h-fix" as never);
    render(<Word trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: "Word text fixed",
        undo: "h-fix",
      });
    });
  });

  it("Suppress sends null expected text for a duplicated index that disagrees", async () => {
    useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    render(<Word trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        true,
        null,
        null,
      );
    });
  });

  it("Unsuppress calls setTranscriptWordSuppressed with the displayed text", async () => {
    useDawStore.setState({ project: projectWithSuppressedWord() });
    render(<Word trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Unsuppress" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordSuppressed).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        false,
        "there",
        null,
      );
    });
  });

  it("Ignore sends null expected text for a duplicated index that disagrees", async () => {
    useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    render(<Word trackId="host" wordIndex={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await vi.waitFor(() => {
      expect(setTranscriptWordsIgnored).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        1,
        1,
        true,
        null,
        null,
      );
    });
  });

  it("marks which action changes audio", () => {
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Text cannot be empty")).toBeInTheDocument();
    expect(correctTranscriptWord).not.toHaveBeenCalled();
  });

  it("shows a failed secondary word action after its controls, apart from the fix form's own error", async () => {
    vi.mocked(setTranscriptWordSuppressed).mockRejectedValueOnce(
      new Error("Could not suppress this word"),
    );
    render(<Word trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Text cannot be empty");
    const suppress = screen.getByRole("button", { name: "Suppress" });
    fireEvent.click(suppress);
    await act(async () => {});
    const alert = screen.getByText("Could not suppress this word");
    expect(
      suppress.compareDocumentPosition(alert) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
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
      <Word key="host:0" trackId="host" wordIndex={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    rerender(<Word key="host:1" trackId="host" wordIndex={1} />);
    expect(screen.getByRole("button", { name: "Suppress" })).toBeEnabled();
    await act(async () => {
      reject(new Error("boom"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useDawStore.getState().transcriptInlineEditFailure).toEqual({
      projectPath: "/tmp/ep",
      trackId: "host",
      sourceId: null,
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
      <Word key="host:0" trackId="host" wordIndex={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    rerender(<Word key="host:1" trackId="host" wordIndex={1} />);
    await act(async () => {
      reject(new Error("boom"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useDawStore.getState().transcriptInlineEditFailure).toEqual({
      projectPath: "/tmp/ep",
      trackId: "host",
      sourceId: null,
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
      <Word key="host:0" trackId="host" wordIndex={0} />,
    );
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
    rerender(<Word key="host:1" trackId="host" wordIndex={1} />);
    await act(async () => {
      reject(new Error("boom"));
    });
    const failure = useDawStore.getState().transcriptInlineEditFailure;
    expect(failure).toEqual({
      projectPath: "/tmp/ep",
      trackId: "host",
      sourceId: null,
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
    render(<Word trackId="host" wordIndex={0} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
  });

  it("a phrase draft and its baseline survive a peer edit of the anchor word (#746)", async () => {
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={0} />);
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
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      applyingWords(["Hello", "there"]),
    );
    render(<Word trackId="host" wordIndex={0} />);
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
    vi.mocked(correctTranscriptPhrase).mockImplementationOnce(
      applyingWords(["Hello", "there", "new"]),
    );
    render(<Word trackId="host" wordIndex={0} />);
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

  it("a successful Apply the store does not read back leaves the baseline unverified (#746)", async () => {
    render(<Word trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(
      screen.getByText(/can't check whether someone else changed/),
    ).toBeInTheDocument();
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
      null,
    );
  });

  it("an Undo of this inspector's own Apply moves the baseline back, so the next Apply does not conflict (#746)", async () => {
    vi.mocked(correctTranscriptWord)
      .mockImplementationOnce(applyingWords(["Hello", "there"]))
      .mockImplementationOnce(applyingWords(["World", "there"]));
    render(<Word trackId="host" wordIndex={0} />);
    const input = screen.getByLabelText("Corrected text");
    const apply = () =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      });
    fireEvent.change(input, { target: { value: "Hello" } });
    await apply();
    fireEvent.change(input, { target: { value: "World" } });
    await apply();
    act(() => {
      useDawStore.setState({ project: projectWithWords(["Hello", "there"]) });
    }); // Undo
    fireEvent.change(input, { target: { value: "Again" } });
    await apply();
    expect(correctTranscriptWord).toHaveBeenNthCalledWith(
      3,
      "/tmp/ep",
      "host",
      0,
      "Again",
      "Hello",
    );
  });

  it("a Redo of this inspector's own Apply moves the baseline forward again (#746)", async () => {
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      applyingWords(["Hello", "there"]),
    );
    render(<Word trackId="host" wordIndex={0} />);
    const input = screen.getByLabelText("Corrected text");
    fireEvent.change(input, { target: { value: "Hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    act(() => {
      useDawStore.setState({ project: project() });
    }); // Undo
    act(() => {
      useDawStore.setState({ project: projectWithWords(["Hello", "there"]) });
    }); // Redo
    fireEvent.change(input, { target: { value: "World" } });
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

  it("an Undo of a phrase Apply that added a word moves End index back (#746)", async () => {
    vi.mocked(correctTranscriptPhrase).mockImplementationOnce(
      applyingWords(["Hello", "there", "new"]),
    );
    render(<Word trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello there new" },
    });
    fireEvent.change(screen.getByLabelText("End word index"), {
      target: { value: "1" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(screen.getByLabelText("End word index")).toHaveValue(2);
    act(() => {
      useDawStore.setState({ project: project() });
    }); // Undo
    expect(screen.getByLabelText("End word index")).toHaveValue(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(correctTranscriptPhrase).toHaveBeenNthCalledWith(
      2,
      "/tmp/ep",
      "host",
      0,
      1,
      "Hello there new",
      "hello there",
    );
  });

  it("an Undo of an Apply sent unguarded goes back to sending no text, not a stale baseline (#746)", async () => {
    useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      applyingWords(["hello", "There"]),
    );
    render(<Word trackId="host" wordIndex={1} />);
    const input = screen.getByLabelText("Corrected text");
    const apply = () =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      });
    fireEvent.change(input, { target: { value: "There" } });
    await apply();
    expect(correctTranscriptWord).toHaveBeenNthCalledWith(
      1,
      "/tmp/ep",
      "host",
      1,
      "There",
      null,
    );
    expect(
      screen.queryByText(/can't check whether someone else changed/),
    ).toBeNull();
    act(() => {
      useDawStore.setState({ project: projectWithDisagreeingDuplicate() });
    }); // Undo
    expect(
      screen.getByText(/can't check whether someone else changed/),
    ).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Again" } });
    await apply();
    expect(correctTranscriptWord).toHaveBeenNthCalledWith(
      2,
      "/tmp/ep",
      "host",
      1,
      "Again",
      null,
    );
  });

  it("a peer edit to text this inspector never applied still sends the old baseline (#746)", async () => {
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      applyingWords(["Hello", "there"]),
    );
    render(<Word trackId="host" wordIndex={0} />);
    const input = screen.getByLabelText("Corrected text");
    fireEvent.change(input, { target: { value: "Hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    act(() => {
      useDawStore.setState({ project: projectWithWords(["Howdy", "there"]) });
    });
    fireEvent.change(input, { target: { value: "World" } });
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

  it('after a 409, the second Apply sends the store\'s new span text ("hello where") (#746)', async () => {
    let reject!: (e: Error) => void;
    vi.mocked(correctTranscriptPhrase).mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    render(<Word trackId="host" wordIndex={0} />);
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
    expect(
      screen.getByText(/Apply again to retry against the current text/),
    ).toBeInTheDocument();
    expect(screen.queryByText("stale")).toBeNull();
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

  it("after a 409 whose refresh left the store unchanged, keeps the host's message instead of promising a retry (#746)", async () => {
    vi.mocked(correctTranscriptWord).mockRejectedValueOnce(
      new ApiError("stale: re-read the transcript", null, 409),
    );
    render(<Word trackId="host" wordIndex={0} />);
    fireEvent.change(screen.getByLabelText("Corrected text"), {
      target: { value: "Hello" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(
      screen.getByText("stale: re-read the transcript"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Apply again to retry/)).toBeNull();
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

  it("a non-409 failure keeps the baseline (#746)", async () => {
    vi.mocked(correctTranscriptWord).mockRejectedValueOnce(
      new ApiError("boom", null, 500),
    );
    render(<Word trackId="host" wordIndex={0} />);
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
    render(<Word trackId="host" wordIndex={0} />);
    expect(screen.queryByLabelText("Corrected text")).toBeNull();
    act(() => {
      useDawStore.setState({ project: project() });
    });
    expect(screen.getByLabelText("Corrected text")).toHaveValue("hello");
  });

  it("keeps the unverified-span status region mounted, fills it while the hint shows, and describes the End index input only then", async () => {
    const { container } = render(<Word trackId="host" wordIndex={0} />);
    const region = container.querySelector('p[role="status"]');
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
    const endInput = screen.getByLabelText("End word index");
    expect(endInput).not.toHaveAttribute("aria-describedby");
    fireEvent.change(endInput, { target: { value: "5" } });
    const hint = screen.getByText(/can't check whether someone else changed/);
    expect(hint).toBe(region);
    expect(hint).toHaveClass("ui-field-hint");
    expect(endInput).toHaveAttribute("aria-describedby", hint.id);
    fireEvent.change(endInput, { target: { value: "0" } });
    expect(endInput).not.toHaveAttribute("aria-describedby");
    expect(region).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveClass("sr-only");
    await expectNoA11yViolations(container);
  });
});

describe("which sections a transcript range gets", () => {
  const ids = (selection: Parameters<typeof useSelectionSections>[0]) => {
    const seen: { sections: ReturnType<typeof useSelectionSections> }[] = [];
    function Probe() {
      seen.push({ sections: useSelectionSections(selection) });
      return null;
    }
    render(<Probe />);
    return seen.at(-1)?.sections ?? null;
  };
  const word = wordSelection({ trackId: "host", sourceId: null, wordIndex: 0 });
  beforeEach(() => {
    useDawStore.setState({
      project: project(),
      projectPath: "/tmp/ep",
      transcriptCorrecting: false,
      rangeArmed: false,
    });
  });

  it("gives a host's single word its facts, fix and actions after the range", () => {
    expect(ids(word)?.map((s) => s.id)).toEqual([
      "range",
      "word",
      "fix",
      "actions",
      "related",
    ]);
  });

  it("puts the fix first when correcting from the Script", () => {
    useDawStore.setState({ transcriptCorrecting: true });
    expect(ids(word)?.[0]?.id).toBe("fix");
  });

  it("gives a guest on a share link the range only", () => {
    useDawStore.setState({ projectPath: "share:tok" });
    expect(ids(word)?.map((s) => s.id)).toEqual(["range", "related"]);
  });

  it("gives words that are not hydrated the range only", () => {
    const cold = project();
    cold.meta = { ...cold.meta, hydration: { transcript_words: false } };
    useDawStore.setState({ project: cold });
    expect(ids(word)?.map((s) => s.id)).toEqual(["range", "related"]);
  });

  it("gives several words no word fields", () => {
    const several = { ...word, endWordIndex: 1 };
    expect(ids(several)?.map((s) => s.id)).toEqual(["range"]);
  });

  it("says when the word is gone", () => {
    useDawStore.setState({
      project: minimalProject({ transcript: { utterances: [] } }),
    });
    expect(ids(word)?.map((s) => s.id)).toEqual(["range", "gone", "related"]);
  });

  it("leaves other kinds to their own bodies", () => {
    expect(ids({ kind: "chapter", id: "c", time: 1 })).toBeNull();
  });
});

describe("focus when a word opens", () => {
  it("lands on the sheet anchor, because the first control is the Text field", () => {
    useDawStore.setState({ project: project(), projectPath: "/tmp/ep" });
    const { container } = render(
      <div className="sys-inspector">
        <div className="sys-inspector-scroll">
          <Word trackId="host" wordIndex={0} />
        </div>
      </div>,
    );
    focusFirstControl(container as HTMLElement);
    expect(screen.getByTestId("anchor")).toHaveFocus();
  });
});
