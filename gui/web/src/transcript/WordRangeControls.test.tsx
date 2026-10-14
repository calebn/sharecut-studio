import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import { registerTranscriptIgnoreCommands } from "../commands/transcriptIgnore";
import { registerTranscriptRangeCommands } from "../commands/transcriptRange";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { WordRangeControls } from "./WordRangeControls";

vi.mock("../api", () => ({
  setTranscriptWordsIgnored: vi.fn(async () => "head-after-ignore"),
}));

const WORDS = ["so", "the", "plan", "is", "simple", "really", "good", "now"];

function project() {
  return minimalProject({
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: WORDS.length,
          text: WORDS.join(" "),
          words: WORDS.map((text, i) => ({
            text,
            start: i,
            end: i + 0.5,
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

function Harness() {
  const selection = useDaw((s) => s.selection);
  return selection?.kind === "transcriptRange" ? (
    <WordRangeControls selection={selection} />
  ) : null;
}

const button = (name: string) => screen.getByRole("button", { name });

describe("WordRangeControls", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerTranscriptRangeCommands();
    registerTranscriptIgnoreCommands();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: project(),
      selection: range(2, 3),
      statusAnnouncement: "",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the range and its words", () => {
    render(<Harness />);
    expect(screen.getByText(/2 words/)).toBeInTheDocument();
    expect(screen.getByText(/“plan is”/)).toBeInTheDocument();
  });

  it("keeps every Words button out of native selection through the shared hold class", () => {
    render(<Harness />);
    for (const name of [
      "Add word before",
      "Add word after",
      "Drop first word",
      "Drop last word",
    ])
      expect(button(name)).toHaveClass("hold-repeat");
  });

  it("adds and drops a word at either end from the keyboard", () => {
    render(<Harness />);
    fireEvent.click(button("Add word after"));
    expect(useDawStore.getState().selection).toEqual(range(2, 4));
    fireEvent.click(button("Add word before"));
    expect(useDawStore.getState().selection).toEqual(range(1, 4));
    fireEvent.click(button("Drop first word"));
    fireEvent.click(button("Drop last word"));
    expect(useDawStore.getState().selection).toEqual(range(2, 3));
  });

  it("steps once for a press, then repeats while it is held and stops on lift", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const add = button("Add word after");
    fireEvent.pointerDown(add, { button: 0, pointerType: "touch" });
    expect(useDawStore.getState().selection).toEqual(range(2, 4));
    fireEvent.click(add, { detail: 1 });
    expect(useDawStore.getState().selection).toEqual(range(2, 4));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(useDawStore.getState().selection).toEqual(range(2, 5));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(useDawStore.getState().selection).toEqual(range(2, 6));
    fireEvent.pointerUp(add);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(useDawStore.getState().selection).toEqual(range(2, 6));
  });

  it("stops a held repeat at the last word", () => {
    vi.useFakeTimers();
    useDawStore.setState({ selection: range(2, 6) });
    render(<Harness />);
    fireEvent.pointerDown(button("Add word after"), {
      button: 0,
      pointerType: "touch",
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(useDawStore.getState().selection).toEqual(range(2, 7));
    expect(button("Add word after")).toBeDisabled();
    expect(button("Add word after")).toHaveAttribute(
      "title",
      "There is no later word to add.",
    );
    expect(document.querySelector(".range-words-reason")).toHaveTextContent(
      "There is no later word to add.",
    );
  });

  it("disables the drops on a one-word range and says why", () => {
    useDawStore.setState({ selection: range(4, 4) });
    render(<Harness />);
    expect(button("Drop first word")).toBeDisabled();
    expect(button("Drop last word")).toBeDisabled();
    expect(button("Add word before")).toBeEnabled();
    expect(document.querySelector(".range-words-reason")).toBeVisible();
    expect(document.querySelector(".range-words-reason")).toHaveTextContent(
      "The range is one word. Clear it to start over.",
    );
    expect(button("Drop last word")).toHaveAccessibleDescription(
      "The range is one word. Clear it to start over.",
    );
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<Harness />);
    await expectNoA11yViolations(container);
  });

  it("ignores the range from the sheet and offers Undo on the toast", async () => {
    render(<Harness />);
    await act(async () => {
      fireEvent.click(button("Ignore"));
    });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      2,
      3,
      true,
      "plan is",
    );
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Ignored selection",
      undo: "head-after-ignore",
    });
  });

  it("offers Restore, not Ignore, once every word in the range is ignored", async () => {
    const ignored = project();
    for (const word of ignored.transcript!.utterances[0]!.words!) {
      word.ignored = word.word_index === 2 || word.word_index === 3;
    }
    useDawStore.setState({ project: ignored });
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Ignore" })).toBeNull();
    await act(async () => {
      fireEvent.click(button("Restore"));
    });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      2,
      3,
      false,
      "plan is",
    );
  });

  it("leaves Ignore to the host: a share link has no Ignore", () => {
    useDawStore.setState({ projectPath: "share:abc" });
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Ignore" })).toBeNull();
  });
});
