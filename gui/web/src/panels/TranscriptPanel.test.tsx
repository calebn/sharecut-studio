import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { correctTranscriptWord } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { scrollChildIntoParent } from "../utils/transcript";
import { TranscriptPanel } from "./TranscriptPanel";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  correctTranscriptWord: vi.fn(async () => {}),
}));

vi.mock("../utils/transcript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/transcript")>();
  return {
    ...actual,
    scrollChildIntoParent: vi.fn(actual.scrollChildIntoParent),
  };
});

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

function largeProject(turnCount = 1200) {
  const base = project();
  return {
    ...base,
    timeline_duration_sec: turnCount * 2,
    transcript: {
      utterances: Array.from({ length: turnCount }, (_, index) => ({
        track_id: "host",
        speaker: `Speaker ${index}`,
        start: index * 2,
        end: index * 2 + 1,
        text: `turn ${index}`,
        mappable: true,
        timeline_start: index * 2,
        timeline_end: index * 2 + 1,
        words: [
          {
            text: `turn ${index}`,
            start: index * 2,
            end: index * 2 + 1,
            timeline_start: index * 2,
            timeline_end: index * 2 + 1,
            word_index: index,
            confidence: 0.9,
          },
        ],
      })),
    },
  };
}

describe("TranscriptPanel", () => {
  beforeEach(() => {
    vi.mocked(correctTranscriptWord).mockClear();
    useDawStore.setState({
      project: project(),
      projectPath: "/tmp/ep",
      playheadSec: 0,
      selection: null,
      transcriptFollowPlayhead: false,
      layoutMode: "default",
      pointerKind: "fine",
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

  it("renders the shared turn view from live playhead and selection state", () => {
    useDawStore.setState({
      playheadSec: 0.5,
      selection: null,
    });
    const { container } = render(<TranscriptPanel />);
    const turn = container.querySelector(".utterance-turn.active");
    expect(turn).toHaveAttribute("data-turn-index", "0");
    expect(turn).toHaveAttribute("data-presence-anchor", "transcript:turn:0");
    fireEvent.click(within(container).getByRole("button", { name: /Select/ }));
    fireEvent.click(within(container).getByRole("button", { name: "hello" }));
    expect(
      within(container).getByRole("button", { name: "hello" }),
    ).toHaveClass("utterance-word", "active", "selected");
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
    useDawStore.setState({ layoutMode: "text" });
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(
      within(container).getByRole("button", { name: /Correct/i }),
    );
    fireEvent.click(within(container).getByRole("button", { name: "hello" }));
    expect(
      within(container).getByTestId("docked-word-editor").textContent,
    ).toContain("embedded host:0");
  });

  describe("touch gestures", () => {
    const touch = { pointerType: "touch", isPrimary: true, pointerId: 1 };
    const word = (container: HTMLElement, name: string) =>
      within(container).getByRole("button", { name });
    const correctToggle = (container: HTMLElement) =>
      within(container).queryByRole("button", { name: /Correct/ });
    const tap = (el: HTMLElement) => {
      fireEvent.pointerDown(el, touch);
      fireEvent.pointerUp(el, touch);
      fireEvent.click(el);
    };
    const longPress = (el: HTMLElement) => {
      fireEvent.pointerDown(el, touch);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.pointerUp(el, touch);
      fireEvent.click(el);
      act(() => {
        vi.runOnlyPendingTimers();
      });
    };
    const thereWord = {
      kind: "transcriptWord",
      trackId: "host",
      wordIndex: 1,
    } as const;

    it("double-tap seeks on the first tap, then opens correction", () => {
      useDawStore.setState({ playheadSec: 5 });
      const { container } = render(<TranscriptPanel />);
      const there = word(container, "there");
      tap(there);
      expect(useDawStore.getState().playheadSec).toBe(1);
      expect(useDawStore.getState().selection).toBeNull();
      tap(there);
      expect(useDawStore.getState().selection).toEqual(thereWord);
      expect(correctToggle(container)).toHaveAttribute("aria-pressed", "true");
    });

    it("scopes Correct to the gesture: closing restores seek-on-tap", () => {
      vi.useFakeTimers();
      const { container } = render(<TranscriptPanel />);
      const there = word(container, "there");
      tap(there);
      tap(there);
      expect(useDawStore.getState().selection).toEqual(thereWord);
      act(() => {
        useDawStore.getState().setSelection(null);
      });
      expect(correctToggle(container)).toHaveAttribute("aria-pressed", "false");
      // A real close happens well after the double-tap's ghost-click window.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      useDawStore.setState({ playheadSec: 5 });
      fireEvent.click(word(container, "there"));
      expect(useDawStore.getState().playheadSec).toBe(1);
      expect(useDawStore.getState().selection).toBeNull();
      vi.useRealTimers();
    });

    it("long-press opens correction without seeking", () => {
      vi.useFakeTimers();
      useDawStore.setState({ playheadSec: 5 });
      const { container } = render(<TranscriptPanel />);
      longPress(word(container, "there"));
      expect(useDawStore.getState().selection).toEqual(thereWord);
      expect(useDawStore.getState().playheadSec).toBe(5);
      vi.useRealTimers();
    });

    it("restores the Select range after a gesture correction closes", () => {
      vi.useFakeTimers();
      const { container } = render(<TranscriptPanel />);
      fireEvent.click(
        within(container).getByRole("button", { name: /Select/ }),
      );
      fireEvent.click(word(container, "hello"));
      fireEvent.click(word(container, "there"), { shiftKey: true });
      const range = useDawStore.getState().selection;
      expect(range).toMatchObject({ kind: "transcriptRange" });
      longPress(word(container, "there"));
      expect(useDawStore.getState().selection).toEqual(thereWord);
      act(() => {
        useDawStore.getState().setSelection(null);
      });
      expect(useDawStore.getState().selection).toEqual(range);
      expect(
        within(container).getByRole("button", { name: /Select/ }),
      ).toHaveAttribute("aria-pressed", "true");
      vi.useRealTimers();
    });

    it("ignores a long-press whose word vanished during the hold", () => {
      vi.useFakeTimers();
      const { container } = render(<TranscriptPanel />);
      const there = word(container, "there");
      fireEvent.pointerDown(there, touch);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      const base = project();
      act(() => {
        useDawStore.setState({
          project: {
            ...base,
            transcript: {
              utterances: base.transcript!.utterances.map((u) => ({
                ...u,
                words: u.words?.slice(0, 1),
              })),
            },
          },
        });
      });
      fireEvent.pointerUp(there, touch);
      act(() => {
        vi.runOnlyPendingTimers();
      });
      expect(useDawStore.getState().selection).toBeNull();
      vi.useRealTimers();
    });

    it.each([
      [
        "a guest share",
        () => useDawStore.setState({ projectPath: "share:tok" }),
      ],
      [
        "unhydrated words",
        () => {
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
        },
      ],
    ])("never enters Correct for %s", (_name, arrange) => {
      vi.useFakeTimers();
      arrange();
      useDawStore.setState({ playheadSec: 5 });
      const { container } = render(<TranscriptPanel />);
      const there = word(container, "there");
      tap(there);
      tap(there);
      longPress(there);
      expect(useDawStore.getState().selection).toBeNull();
      expect(container.textContent).not.toContain("correct mode");
      expect(useDawStore.getState().playheadSec).toBe(1);
      vi.useRealTimers();
    });
  });

  describe("transcript mode hint", () => {
    it("wraps the toggles in a named group", () => {
      const { container } = render(<TranscriptPanel />);
      const group = within(container).getByRole("group", {
        name: "Transcript mode",
      });
      expect(
        within(group).getByRole("button", { name: /Correct/i }),
      ).toBeTruthy();
      expect(
        within(group).getByRole("button", { name: /Select/i }),
      ).toBeTruthy();
    });

    it("shows the navigate, correct, and select hints", () => {
      const { container } = render(<TranscriptPanel />);
      expect(
        container.querySelector(".transcript-mode-hint"),
      ).toHaveTextContent(/never move or cut audio/);
      fireEvent.click(
        within(container).getByRole("button", { name: /Correct/i }),
      );
      expect(
        container.querySelector(".transcript-mode-hint"),
      ).toHaveTextContent(/text only/);
      fireEvent.click(
        within(container).getByRole("button", { name: /Correct/i }),
      );
      fireEvent.click(
        within(container).getByRole("button", { name: /Select/i }),
      );
      expect(
        container.querySelector(".transcript-mode-hint"),
      ).toHaveTextContent(/edits audio/);
    });

    it("hides the hint for a guest", () => {
      useDawStore.setState({ projectPath: "share:tok" });
      const { container } = render(<TranscriptPanel />);
      expect(container.querySelector(".transcript-mode-hint")).toBeNull();
      expect(container.querySelector(".transcript-inline-status")).toBeNull();
    });

    it("points coarse pointers at double-tap correction", () => {
      useDawStore.setState({ pointerKind: "coarse" });
      const { container } = render(<TranscriptPanel />);
      const hint = container.querySelector(".transcript-mode-hint");
      expect(hint).toHaveTextContent(/Double-tap a word/);
      expect(hint).not.toHaveTextContent(/Enter saves/);
      fireEvent.click(
        within(container).getByRole("button", { name: /Correct/i }),
      );
      expect(
        container.querySelector(".transcript-mode-hint"),
      ).toHaveTextContent(/text only/);
    });

    it("hides the hint for unhydrated transcript words", () => {
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
      expect(container.querySelector(".transcript-mode-hint")).toBeNull();
    });
  });

  describe("inline word edit", () => {
    it("double-click opens a focused textbox with the word's text", () => {
      const { container } = render(<TranscriptPanel />);
      const hello = within(container).getByRole("button", { name: "hello" });
      fireEvent.doubleClick(hello);
      const input = within(container).getByRole("textbox", {
        name: /Correct word/,
      });
      expect(input).toHaveFocus();
      expect(input).toHaveValue("hello");
    });

    it("Enter commits the change and refocuses the chip", async () => {
      const { container } = render(<TranscriptPanel />);
      const hello = within(container).getByRole("button", { name: "hello" });
      fireEvent.doubleClick(hello);
      const input = within(container).getByRole("textbox", {
        name: /Correct word/,
      });
      fireEvent.change(input, { target: { value: "Hello" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.waitFor(() => {
        expect(correctTranscriptWord).toHaveBeenCalledWith(
          "/tmp/ep",
          "host",
          0,
          "Hello",
        );
      });
      await vi.waitFor(() => {
        expect(
          within(container).queryByRole("textbox", { name: /Correct word/ }),
        ).toBeNull();
      });
      expect(useDawStore.getState().selection).toBeNull();
    });

    it("Escape closes without a call and refocuses the chip", () => {
      const { container } = render(<TranscriptPanel />);
      const hello = within(container).getByRole("button", { name: "hello" });
      fireEvent.doubleClick(hello);
      const input = within(container).getByRole("textbox", {
        name: /Correct word/,
      });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(correctTranscriptWord).not.toHaveBeenCalled();
      expect(
        within(container).queryByRole("textbox", { name: /Correct word/ }),
      ).toBeNull();
    });

    it.each([
      [
        "a guest share",
        () => useDawStore.setState({ projectPath: "share:tok" }),
      ],
      [
        "unhydrated words",
        () => {
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
        },
      ],
    ])("leaves no textbox and keeps seek for %s", (_name, arrange) => {
      arrange();
      useDawStore.setState({ playheadSec: 5 });
      const { container } = render(<TranscriptPanel />);
      const hello = within(container).getByRole("button", { name: "hello" });
      fireEvent.doubleClick(hello);
      expect(
        within(container).queryByRole("textbox", { name: /Correct word/ }),
      ).toBeNull();
      expect(useDawStore.getState().playheadSec).toBe(0);
    });

    it("Select intent does not open the editor", () => {
      const { container } = render(<TranscriptPanel />);
      fireEvent.click(
        within(container).getByRole("button", { name: /Select/i }),
      );
      const hello = within(container).getByRole("button", { name: "hello" });
      fireEvent.doubleClick(hello);
      expect(
        within(container).queryByRole("textbox", { name: /Correct word/ }),
      ).toBeNull();
    });

    it("touch double-tap opens Correct, not the inline editor", () => {
      const touch = { pointerType: "touch", isPrimary: true, pointerId: 1 };
      const { container } = render(<TranscriptPanel />);
      const hello = within(container).getByRole("button", { name: "hello" });
      const tap = (el: HTMLElement) => {
        fireEvent.pointerDown(el, touch);
        fireEvent.pointerUp(el, touch);
        fireEvent.click(el);
      };
      tap(hello);
      tap(hello);
      fireEvent.doubleClick(hello);
      expect(
        within(container).queryByRole("textbox", { name: /Correct word/ }),
      ).toBeNull();
      expect(useDawStore.getState().selection).toEqual({
        kind: "transcriptWord",
        trackId: "host",
        wordIndex: 0,
      });
    });

    it("closes the editor when switching to Correct", () => {
      const { container } = render(<TranscriptPanel />);
      const hello = within(container).getByRole("button", { name: "hello" });
      fireEvent.doubleClick(hello);
      expect(
        within(container).getByRole("textbox", { name: /Correct word/ }),
      ).toBeTruthy();
      fireEvent.click(
        within(container).getByRole("button", { name: /Correct/i }),
      );
      expect(
        within(container).queryByRole("textbox", { name: /Correct word/ }),
      ).toBeNull();
    });

    it("a late close from an unmounted editor does not move focus later", async () => {
      let resolve: () => void = () => {};
      vi.mocked(correctTranscriptWord).mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      );
      const { container } = render(<TranscriptPanel />);
      const q = within(container);
      fireEvent.doubleClick(q.getByRole("button", { name: "hello" }));
      const input = q.getByRole("textbox", { name: /Correct word/ });
      fireEvent.change(input, { target: { value: "Hello" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
      // Switching mode unmounts the editor while its commit is in flight.
      fireEvent.click(q.getByRole("button", { name: /Correct/i }));
      await act(async () => {
        resolve();
      });
      fireEvent.click(q.getByRole("button", { name: /Correct/i }));
      fireEvent.doubleClick(q.getByRole("button", { name: "there" }));
      fireEvent.blur(q.getByRole("textbox", { name: /Correct word/ }));
      expect(q.queryByRole("textbox", { name: /Correct word/ })).toBeNull();
      expect(q.getByRole("button", { name: "hello" })).not.toHaveFocus();
    });

    it("leaves focus on a field the user moved to while a commit ran", async () => {
      const outside = document.createElement("input");
      outside.setAttribute("aria-label", "outside");
      document.body.append(outside);
      try {
        let resolve: () => void = () => {};
        vi.mocked(correctTranscriptWord).mockImplementationOnce(
          () =>
            new Promise<void>((r) => {
              resolve = r;
            }),
        );
        const { container } = render(<TranscriptPanel />);
        const q = within(container);
        fireEvent.doubleClick(q.getByRole("button", { name: "hello" }));
        const input = q.getByRole("textbox", { name: /Correct word/ });
        fireEvent.change(input, { target: { value: "Hello" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await vi.waitFor(() =>
          expect(correctTranscriptWord).toHaveBeenCalled(),
        );
        act(() => outside.focus());
        await act(async () => {
          resolve();
        });
        await vi.waitFor(() =>
          expect(q.queryByRole("textbox", { name: /Correct word/ })).toBeNull(),
        );
        expect(outside).toHaveFocus();
        expect(q.getByRole("button", { name: "hello" })).not.toHaveFocus();
      } finally {
        outside.remove();
      }
    });

    it("shows a failed commit after a mode switch closed its editor", async () => {
      let reject: (e: Error) => void = () => {};
      vi.mocked(correctTranscriptWord).mockImplementationOnce(
        () =>
          new Promise<void>((_r, rej) => {
            reject = rej;
          }),
      );
      const { container } = render(<TranscriptPanel />);
      const q = within(container);
      fireEvent.doubleClick(q.getByRole("button", { name: "hello" }));
      const input = q.getByRole("textbox", { name: /Correct word/ });
      fireEvent.change(input, { target: { value: "Hello" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
      fireEvent.click(q.getByRole("button", { name: /Correct/i }));
      expect(q.queryByRole("textbox", { name: /Correct word/ })).toBeNull();
      await act(async () => {
        reject(new Error("server said no"));
      });
      await vi.waitFor(() =>
        expect(container.querySelector(".inline-error")).toHaveTextContent(
          "Could not fix “hello”: server said no",
        ),
      );
      fireEvent.click(q.getByRole("button", { name: /Correct/i }));
      fireEvent.doubleClick(q.getByRole("button", { name: "there" }));
      expect(q.getByRole("textbox", { name: /there/ })).toBeTruthy();
      expect(container.querySelector(".inline-error")).toBeNull();
    });

    it("keeps a pending editor when another word is double-clicked", async () => {
      let resolve: () => void = () => {};
      vi.mocked(correctTranscriptWord).mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      );
      const { container } = render(<TranscriptPanel />);
      const q = within(container);
      fireEvent.doubleClick(q.getByRole("button", { name: "hello" }));
      const input = q.getByRole("textbox", { name: /Correct word/ });
      fireEvent.change(input, { target: { value: "Hello" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
      fireEvent.doubleClick(q.getByRole("button", { name: "there" }));
      expect(q.getByRole("textbox", { name: /hello/ })).toHaveValue("Hello");
      expect(q.queryByRole("textbox", { name: /there/ })).toBeNull();
      expect(
        container.querySelector(".transcript-inline-status"),
      ).toHaveTextContent(/Saving the word fix/);
      await act(async () => {
        resolve();
      });
      await vi.waitFor(() =>
        expect(q.queryByRole("textbox", { name: /Correct word/ })).toBeNull(),
      );
      expect(
        container.querySelector(".transcript-inline-status")?.textContent,
      ).toBe("");
      fireEvent.doubleClick(q.getByRole("button", { name: "there" }));
      expect(q.getByRole("textbox", { name: /there/ })).toHaveFocus();
    });

    it("has no axe violations with the editor open", async () => {
      const { container } = render(<TranscriptPanel />);
      const hello = within(container).getByRole("button", { name: "hello" });
      fireEvent.doubleClick(hello);
      await expectNoA11yViolations(container);
    });
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

  it("Annotate marks words flagged suspect_hallucination", () => {
    const base = project();
    const word = base.transcript?.utterances[0]?.words?.[1];
    if (!word) throw new Error("fixture word missing");
    word.suspect_hallucination = true;
    useDawStore.setState({ project: base, transcriptAnnotate: false });
    const { container } = render(<TranscriptPanel />);
    expect(container.querySelectorAll(".suspect-hallucination")).toHaveLength(
      0,
    );
    fireEvent.click(
      within(container).getByRole("button", { name: /Annotate/i }),
    );
    const flagged = container.querySelectorAll(
      ".utterance-word.suspect-hallucination",
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain("there");
    expect(flagged[0]).toHaveAttribute(
      "title",
      expect.stringContaining("Possible transcription over silence"),
    );
    expect(flagged[0]).toHaveAccessibleName(
      "there · Possible transcription over silence",
    );
  });

  it("Annotate leaves suppressed suspect_hallucination words with only the strikethrough", () => {
    const base = project();
    const word = base.transcript?.utterances[0]?.words?.[1];
    if (!word) throw new Error("fixture word missing");
    word.suspect_hallucination = true;
    word.suppressed = true;
    useDawStore.setState({ project: base, transcriptAnnotate: false });
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(
      within(container).getByRole("button", { name: /Annotate/i }),
    );
    expect(container.querySelectorAll(".suspect-hallucination")).toHaveLength(
      0,
    );
    expect(
      container.querySelector(".utterance-word.suppressed")?.textContent,
    ).toContain("there");
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
    fireEvent.wheel(list!);
    fireEvent.scroll(list!);
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("ignores scroll events without user input (programmatic writes)", () => {
    useDawStore.setState({
      followingClientId: "a",
      transcriptFollowPlayhead: true,
    });
    const { container } = render(<TranscriptPanel />);
    const list = container.querySelector(".transcript-list")!;
    fireEvent.scroll(list);
    // Clicking a child (e.g. a word) is not scroll intent either.
    fireEvent.pointerDown(
      within(container).getByRole("button", { name: "hello" }),
    );
    fireEvent.scroll(list);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(true);
    expect(useDawStore.getState().followingClientId).toBe("a");
    fireEvent.keyDown(list, { key: "PageDown" });
    fireEvent.scroll(list);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(false);
    expect(useDawStore.getState().followingClientId).toBeNull();
  });
});

describe("TranscriptPanel virtualization", () => {
  let scrollTopWrites: number[];

  beforeEach(() => {
    scrollTopWrites = [];
    let scrollTop = 0;
    // virtual-core reads offset*/client* sizes; list = 600px, turns = 96px.
    const size = (listPx: number, turnPx: number) =>
      function (this: HTMLElement) {
        return this.classList.contains("transcript-list") ? listPx : turnPx;
      };
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      size(600, 96),
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      size(600, 96),
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1200 * 96,
    );
    // Turns sit at their translateY offset, shifted by the list's scrollTop.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("transcript-list")) {
          return DOMRect.fromRect({ width: 800, height: 600 });
        }
        const turn = this.closest<HTMLElement>(".utterance-turn");
        const y = Number(
          /translateY\(([-\d.]+)px\)/.exec(turn?.style.transform ?? "")?.[1] ??
            0,
        );
        return DOMRect.fromRect({ y: y - scrollTop, width: 800, height: 96 });
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
      () => scrollTop,
    );
    vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
      function (this: HTMLElement, v: number) {
        scrollTop = v;
        scrollTopWrites.push(v);
        // Browsers fire scroll after a programmatic write (no user input).
        this.dispatchEvent(new Event("scroll"));
      },
    );
    vi.mocked(scrollChildIntoParent).mockClear();
    useDawStore.setState({
      project: largeProject(),
      projectPath: "/tmp/ep",
      playheadSec: 0.5,
      selection: null,
      transcriptFollowPlayhead: false,
      transcriptScrollRequest: null,
      followingClientId: null,
      layoutMode: "default",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const turnEl = (container: HTMLElement, index: number) =>
    container.querySelector<HTMLElement>(`[data-turn-index="${index}"]`);
  const lastScrolledTurn = () => {
    const el = vi.mocked(scrollChildIntoParent).mock.lastCall?.[1];
    return el?.closest("[data-turn-index]")?.getAttribute("data-turn-index");
  };

  it("renders a bounded, labelled list of turns", async () => {
    const { container } = render(<TranscriptPanel />);
    const turns = container.querySelectorAll(".utterance-turn");
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.length).toBeLessThan(1200);
    expect(turnEl(container, 0)).toBeTruthy();
    expect(turnEl(container, 1199)).toBeNull();
    const list = container.querySelector(".transcript-list.is-virtualized");
    expect(list?.getAttribute("role")).toBe("list");
    expect(turnEl(container, 0)?.getAttribute("aria-setsize")).toBe("1200");
    expect(turnEl(container, 0)?.getAttribute("aria-posinset")).toBe("1");
    await expectNoA11yViolations(container);
  });

  it("mounts an offscreen request target, scrolls to it, and clears it", () => {
    const { container } = render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:1199");
    });
    expect(useDawStore.getState().transcriptScrollRequest).toBeNull();
    expect(lastScrolledTurn()).toBe("1199");
    expect(vi.mocked(scrollChildIntoParent).mock.lastCall?.[2]).toBe(0.2);
    expect(turnEl(container, 1199)).toBeTruthy();
    expect(scrollTopWrites.at(-1)).toBeGreaterThan(100_000);
  });

  it("clears an unresolvable request instead of retrying", () => {
    render(<TranscriptPanel />);
    act(() => {
      useDawStore
        .getState()
        .setTranscriptScrollRequest("transcript:word:nobody:424242");
    });
    expect(useDawStore.getState().transcriptScrollRequest).toBeNull();
    expect(vi.mocked(scrollChildIntoParent)).not.toHaveBeenCalled();
  });

  it("follows an offscreen active turn without unlocking follow", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    const { container } = render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setPlayheadSec(1199 * 2 + 0.5);
    });
    expect(turnEl(container, 1199)).toBeTruthy();
    expect(lastScrolledTurn()).toBe("1199");
    expect(scrollTopWrites.at(-1)).toBeGreaterThan(100_000);
    // Re-measure / range scrolls arrive without user input.
    fireEvent.scroll(container.querySelector(".transcript-list")!);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(true);
  });

  it("unlocks follow on a manual wheel scroll", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    const { container } = render(<TranscriptPanel />);
    const list = container.querySelector(".transcript-list")!;
    fireEvent.wheel(list);
    fireEvent.scroll(list);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(false);
  });

  it("lets a paused follower keep the leader's jump until the playhead moves", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    const { container } = render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:900");
    });
    expect(lastScrolledTurn()).toBe("900");
    expect(turnEl(container, 900)).toBeTruthy();
    vi.mocked(scrollChildIntoParent).mockClear();
    // Re-run follow (new project identity, same playhead): must not snap back.
    act(() => {
      useDawStore.setState({ project: largeProject() });
    });
    expect(vi.mocked(scrollChildIntoParent)).not.toHaveBeenCalled();
    act(() => {
      useDawStore.getState().setPlayheadSec(2.5);
    });
    expect(lastScrolledTurn()).toBe("1");
    expect(vi.mocked(scrollChildIntoParent).mock.lastCall?.[2]).toBe(0.5);
  });

  it("keeps the selected and focused turns mounted when scrolled away", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(
      within(container).getByRole("button", { name: /Correct/i }),
    );
    act(() => {
      useDawStore.setState({
        selection: { kind: "transcriptWord", trackId: "host", wordIndex: 1100 },
      });
    });
    expect(turnEl(container, 1100)).toBeTruthy();
    const word = within(turnEl(container, 0)!).getByRole("button", {
      name: "turn 0",
    });
    fireEvent.focus(word);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:1199");
    });
    expect(turnEl(container, 0)).toBeTruthy();
  });

  it("keeps the inline-edited turn mounted while its commit runs", async () => {
    let resolve: () => void = () => {};
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const { container } = render(<TranscriptPanel />);
    const turn3 = turnEl(container, 3)!;
    fireEvent.doubleClick(
      within(turn3).getByRole("button", { name: "turn 3" }),
    );
    const input = within(container).getByRole("textbox", { name: /turn 3/ });
    fireEvent.change(input, { target: { value: "Turn 3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
    fireEvent.focusOut(input, { relatedTarget: document.body });
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:1199");
    });
    expect(turnEl(container, 3)).toBeTruthy();
    expect(
      within(container).getByRole("textbox", { name: /turn 3/ }),
    ).toHaveValue("Turn 3");
    await act(async () => {
      resolve();
    });
  });
});
