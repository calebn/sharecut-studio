import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
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
    });
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
      rangeArmed: false,
    });
  });

  it("gives a host's single word its facts and actions after the range, with no text form", () => {
    expect(ids(word)?.map((s) => s.id)).toEqual(["range", "word", "actions"]);
  });

  it("gives a guest on a share link the range only", () => {
    useDawStore.setState({ projectPath: "share:tok" });
    expect(ids(word)?.map((s) => s.id)).toEqual(["range"]);
  });

  it("gives words that are not hydrated the range only", () => {
    const cold = project();
    cold.meta = { ...cold.meta, hydration: { transcript_words: false } };
    useDawStore.setState({ project: cold });
    expect(ids(word)?.map((s) => s.id)).toEqual(["range"]);
  });

  it("gives several words no word fields", () => {
    const several = { ...word, endWordIndex: 1 };
    expect(ids(several)?.map((s) => s.id)).toEqual(["range"]);
  });

  it("says when the word is gone", () => {
    useDawStore.setState({
      project: minimalProject({ transcript: { utterances: [] } }),
    });
    expect(ids(word)?.map((s) => s.id)).toEqual(["range", "gone"]);
  });

  it("leaves other kinds to their own bodies", () => {
    expect(
      ids({ kind: "envelopePoint", trackId: "host", pointId: "e1" }),
    ).toBeNull();
  });
});

describe("focus when a word opens", () => {
  it("lands on the first action, because a word has no text form: Fix text is inline", () => {
    useDawStore.setState({ project: project(), projectPath: "/tmp/ep" });
    const { container } = render(
      <div className="sys-inspector">
        <div className="sys-inspector-scroll">
          <Word trackId="host" wordIndex={0} />
        </div>
      </div>,
    );
    focusFirstControl(container as HTMLElement);
    expect(screen.getByRole("button", { name: "Suppress" })).toHaveFocus();
    expect(screen.queryByLabelText("Corrected text")).toBeNull();
  });
});
