import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerTranscriptRangeCommands } from "../commands/transcriptRange";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { WordRangeControls } from "./WordRangeControls";

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
    useDawStore.setState({
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
    expect(screen.getByText("There is no later word to add.")).toBeVisible();
  });

  it("disables the drops on a one-word range and says why", () => {
    useDawStore.setState({ selection: range(4, 4) });
    render(<Harness />);
    expect(button("Drop first word")).toBeDisabled();
    expect(button("Drop last word")).toBeDisabled();
    expect(button("Add word before")).toBeEnabled();
    expect(
      screen.getByText("The range is one word. Clear it to start over."),
    ).toBeVisible();
    expect(button("Drop last word")).toHaveAccessibleDescription(
      "The range is one word. Clear it to start over.",
    );
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<Harness />);
    await expectNoA11yViolations(container);
  });
});
