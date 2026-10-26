import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FILLER_EXCERPT, fillerPeaks } from "../review/reviewFixtures";
import { DecisionCard, type DecisionCardProps } from "./DecisionCard";
import { Suggestion } from "./Suggestion";

const base = (): DecisionCardProps => ({
  kind: "filler",
  title: "Remove “um, you know,”",
  time: "18:36",
  excerpt: <Suggestion segments={FILLER_EXCERPT} />,
  why: "Jon restarts the sentence.",
  waveform: {
    peaks: fillerPeaks,
    windowStart: 1108.8,
    start: 1114.4,
    end: 1115.2,
  },
  audition: { side: "A", onSide: vi.fn() },
  onVerb: vi.fn(),
  onKeep: vi.fn(),
  onLater: vi.fn(),
  onOpenInEdit: vi.fn(),
});

describe("DecisionCard", () => {
  it("puts Keep before the verb, and the verb last", () => {
    render(<DecisionCard {...base()} />);
    const names = within(screen.getByRole("group", { name: "Actions" }))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Open in Edit", "Later", "Keep", "Cut"]);
  });

  it.each([
    ["filler", "Cut"],
    ["pause", "Shorten"],
    ["sound", "Lower"],
    ["comment", "Resolve"],
    ["check", "Approve"],
    ["unsure-word", "Looks right"],
  ] as const)("a %s card's verb is %s", (kind, verb) => {
    render(
      <DecisionCard
        {...base()}
        kind={kind}
        waveform={undefined}
        audition={undefined}
      />,
    );
    expect(screen.getByRole("button", { name: verb })).toBeInTheDocument();
  });

  it("switches A/B to B when a handle is touched", () => {
    const props = base();
    render(<DecisionCard {...props} />);
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "End of the change" }),
      {
        key: "ArrowRight",
      },
    );
    expect(props.audition?.onSide).toHaveBeenCalledWith("B");
  });

  it("does not switch again when B is already chosen", () => {
    const props = base();
    render(
      <DecisionCard {...props} audition={{ side: "B", onSide: vi.fn() }} />,
    );
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "End of the change" }),
      {
        key: "ArrowRight",
      },
    );
    expect(props.audition?.onSide).not.toHaveBeenCalled();
  });

  it("holds a cut back until an unsure word is checked", async () => {
    const onLooksRight = vi.fn();
    render(
      <DecisionCard
        {...base()}
        unsure={{ word: "uncle", guess: "uncle", onFix: vi.fn(), onLooksRight }}
      />,
    );
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Looks right" }));
    expect(onLooksRight).toHaveBeenCalled();
  });

  it("enables the cut once the unsure word is resolved", () => {
    render(
      <DecisionCard
        {...base()}
        unsure={{
          word: "uncle",
          guess: "uncle",
          resolved: true,
          onFix: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Cut" })).toBeEnabled();
  });

  it("shows the prompt in place of the verb, and Cut anyway sends the note", async () => {
    const onConfirm = vi.fn();
    render(
      <DecisionCard
        {...base()}
        prompt={{
          verb: "cut",
          checkLabel: "Check 3 words",
          onConfirm,
          onCheck: vi.fn(),
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Cut" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add a note" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your reason" }),
      "Heard it",
    );
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(onConfirm).toHaveBeenCalledWith("Heard it");
  });

  it("gives a guest Open in Edit only", () => {
    render(<DecisionCard {...base()} readOnly />);
    expect(screen.queryByRole("button", { name: "Cut" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(
      screen.getByRole("slider", { name: "End of the change" }),
    ).toHaveAttribute("aria-readonly", "true");
  });

  it("names the empty, error and loading states", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<DecisionCard {...base()} state="empty" />);
    expect(screen.getByText("Nothing to decide")).toBeInTheDocument();
    rerender(<DecisionCard {...base()} state="error" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<DecisionCard {...base()} state="loading" />);
    expect(document.querySelector(".sys-skeleton")).not.toBeNull();
  });

  it("moves the Action bar into a dock with A/B in the middle on phone", () => {
    render(<DecisionCard {...base()} layout="phone" />);
    const dock = screen.getByRole("group", { name: "Actions" });
    expect(dock).toHaveClass("sys-actions--dock");
    expect(
      within(dock).getByRole("group", { name: "Audition" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Audition" })).toHaveLength(1);
  });

  it("swipes on phone: 80 px decides, less springs back", () => {
    const props = base();
    const { container } = render(<DecisionCard {...props} layout="phone" />);
    const body = container.querySelector(".sys-decision-body") as Element;
    const swipe = (dx: number, dy: number) => {
      fireEvent.pointerDown(body, {
        clientX: 100,
        clientY: 100,
        isPrimary: true,
        pointerId: 1,
      });
      fireEvent.pointerMove(body, {
        clientX: 100 + dx,
        clientY: 100 + dy,
        pointerId: 1,
      });
      fireEvent.pointerUp(body, {
        clientX: 100 + dx,
        clientY: 100 + dy,
        pointerId: 1,
      });
    };
    swipe(79, 0);
    expect(props.onVerb).not.toHaveBeenCalled();
    swipe(80, 0);
    expect(props.onVerb).toHaveBeenCalledOnce();
    swipe(-80, 0);
    expect(props.onKeep).toHaveBeenCalledOnce();
    swipe(0, -80);
    expect(props.onLater).toHaveBeenCalledOnce();
  });

  it("does not swipe on the card layout", () => {
    const props = base();
    const { container } = render(<DecisionCard {...props} />);
    const body = container.querySelector(".sys-decision-body") as Element;
    fireEvent.pointerDown(body, {
      clientX: 0,
      clientY: 0,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerUp(body, { clientX: 200, clientY: 0, pointerId: 1 });
    expect(props.onVerb).not.toHaveBeenCalled();
  });

  it("shows a comment under the actions, collapsed to its first line", () => {
    render(
      <DecisionCard
        {...base()}
        comment={{
          author: { name: "Rosa" },
          time: "18:34",
          body: "Keep some pause?",
        }}
      />,
    );
    expect(screen.getByText("Keep some pause?")).toHaveClass(
      "sys-decision-thread-body",
    );
  });
});
