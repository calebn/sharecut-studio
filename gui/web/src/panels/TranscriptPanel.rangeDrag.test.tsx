import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { TranscriptPanel } from "./TranscriptPanel";

const WORDS = ["so", "the", "plan", "is", "simple", "really"];

function project() {
  return minimalProject({
    timeline_duration_sec: 10,
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: WORDS.length,
          text: WORDS.join(" "),
          mappable: true,
          timeline_start: 0,
          timeline_end: WORDS.length,
          words: WORDS.map((text, i) => ({
            text,
            start: i,
            end: i + 1,
            timeline_start: i,
            timeline_end: i + 1,
            word_index: i,
            confidence: 0.9,
          })),
        },
      ],
    },
  });
}

const finger = (id = 1, x = 10, y = 10) => ({
  pointerType: "touch",
  isPrimary: id === 1,
  pointerId: id,
  clientX: x,
  clientY: y,
});

const range = (start: number, end: number) =>
  ({
    kind: "transcriptRange",
    trackId: "host",
    startWordIndex: start,
    endWordIndex: end,
  }) as const;

describe("TranscriptPanel touch range drag", () => {
  let container: HTMLElement;
  const word = (name: string) =>
    within(container).getByRole("button", { name });
  const under = (el: Element | null) => {
    document.elementsFromPoint = () => (el ? [el] : []);
  };
  const hold = () =>
    act(() => {
      vi.advanceTimersByTime(600);
    });
  const selectMode = () =>
    fireEvent.click(within(container).getByRole("button", { name: /Select/ }));

  beforeEach(() => {
    vi.useFakeTimers();
    useDawStore.setState({
      project: project(),
      projectPath: "/tmp/ep",
      selection: null,
      playheadSec: 0,
    });
    ({ container } = render(<TranscriptPanel />));
    selectMode();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as Partial<Document>).elementsFromPoint;
  });

  it("selects the words a long press then a drag crosses, only when the finger lifts", () => {
    fireEvent.pointerDown(word("the"), finger());
    hold();
    expect(useDawStore.getState().selection).toBeNull();
    under(word("is"));
    fireEvent.pointerMove(word("the"), finger(1, 60, 10));
    expect(word("plan").className).toContain("selected");
    expect(word("simple").className).not.toContain("selected");
    expect(useDawStore.getState().selection).toBeNull();
    fireEvent.pointerUp(word("is"), finger(1, 60, 10));
    fireEvent.click(word("is"));
    expect(useDawStore.getState().selection).toEqual(range(1, 3));
    expect(useDawStore.getState().statusAnnouncement).toBe("3 words selected");
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("reads a drag back toward the start as the same range", () => {
    fireEvent.pointerDown(word("simple"), finger());
    hold();
    under(word("plan"));
    fireEvent.pointerMove(word("simple"), finger(1, 10, 80));
    fireEvent.pointerUp(word("plan"), finger(1, 10, 80));
    expect(useDawStore.getState().selection).toEqual(range(2, 4));
  });

  it("scrolls, and selects nothing, when the finger moves before the hold", () => {
    fireEvent.pointerDown(word("the"), finger());
    under(word("is"));
    fireEvent.pointerMove(word("the"), finger(1, 10, 60));
    hold();
    fireEvent.pointerMove(word("the"), finger(1, 60, 60));
    fireEvent.pointerUp(word("is"), finger(1, 60, 60));
    expect(useDawStore.getState().selection).toBeNull();
    expect(word("plan").className).not.toContain("selected");
  });

  it("puts the earlier selection back when a second finger lands", () => {
    act(() => {
      useDawStore.getState().setSelection(range(0, 1));
    });
    fireEvent.pointerDown(word("plan"), finger());
    hold();
    under(word("simple"));
    fireEvent.pointerMove(word("plan"), finger(1, 60, 10));
    expect(useDawStore.getState().selection).toBeNull();
    fireEvent.pointerDown(word("plan"), finger(2));
    expect(useDawStore.getState().selection).toEqual(range(0, 1));
    fireEvent.pointerUp(word("plan"), finger(1, 60, 10));
    expect(useDawStore.getState().selection).toEqual(range(0, 1));
    expect(word("simple").className).not.toContain("selected");
  });

  it("cleans up the drag and puts the earlier selection back when the browser cancels the touch", () => {
    act(() => {
      useDawStore.getState().setSelection(range(0, 1));
    });
    fireEvent.pointerDown(word("plan"), finger());
    hold();
    under(word("simple"));
    fireEvent.pointerMove(word("plan"), finger(1, 60, 10));
    expect(word("simple").className).toContain("selected");
    fireEvent.pointerCancel(word("plan"), finger(1, 60, 10));
    expect(useDawStore.getState().selection).toEqual(range(0, 1));
    expect(word("simple").className).not.toContain("selected");
    fireEvent.pointerMove(word("plan"), finger(1, 90, 10));
    fireEvent.pointerUp(word("simple"), finger(1, 90, 10));
    expect(useDawStore.getState().selection).toEqual(range(0, 1));
  });

  it("puts the earlier selection back when the panel unmounts mid-drag", () => {
    act(() => {
      useDawStore.getState().setSelection(range(0, 1));
    });
    fireEvent.pointerDown(word("plan"), finger());
    hold();
    under(word("simple"));
    fireEvent.pointerMove(word("plan"), finger(1, 60, 10));
    expect(useDawStore.getState().selection).toBeNull();
    cleanup();
    expect(useDawStore.getState().selection).toEqual(range(0, 1));
  });

  it("does not let the click after the lift reset the range to one word", () => {
    fireEvent.pointerDown(word("the"), finger());
    hold();
    under(word("is"));
    fireEvent.pointerMove(word("the"), finger(1, 60, 10));
    fireEvent.pointerUp(word("is"), finger(1, 60, 10));
    fireEvent.click(word("the"));
    expect(useDawStore.getState().selection).toEqual(range(1, 3));
  });

  it("leaves a hold that never moves to word correction", () => {
    fireEvent.pointerDown(word("plan"), finger());
    hold();
    fireEvent.pointerUp(word("plan"), finger());
    fireEvent.click(word("plan"));
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(useDawStore.getState().selection).toEqual({
      kind: "transcriptWord",
      trackId: "host",
      wordIndex: 2,
    });
  });

  it("ignores a mouse press, which keeps its own drag", () => {
    fireEvent.pointerDown(word("the"), {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 1,
    });
    hold();
    expect(word("the").className).not.toContain("selected");
  });
});
