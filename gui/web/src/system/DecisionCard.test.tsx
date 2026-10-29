import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FILLER_EXCERPT, FILLER_WAVEFORM } from "../storybook/reviewFixtures";
import { DecisionCard, type DecisionCardProps } from "./DecisionCard";
import { Suggestion } from "./Suggestion";

const base = (): DecisionCardProps => ({
  kind: "filler",
  title: "Remove “um, you know,”",
  time: "18:36",
  excerpt: <Suggestion segments={FILLER_EXCERPT} />,
  why: "Jon restarts the sentence.",
  waveform: FILLER_WAVEFORM,
  audition: { side: "A", onSide: vi.fn() },
  onVerb: vi.fn(),
  onKeep: vi.fn(),
  onLater: vi.fn(),
  onOpenInEdit: vi.fn(),
});

const swipe = (el: Element, dx: number, dy: number) => {
  fireEvent.pointerDown(el, {
    clientX: 100,
    clientY: 100,
    isPrimary: true,
    pointerId: 1,
  });
  fireEvent.pointerMove(el, {
    clientX: 100 + dx,
    clientY: 100 + dy,
    pointerId: 1,
  });
  fireEvent.pointerUp(el, {
    clientX: 100 + dx,
    clientY: 100 + dy,
    pointerId: 1,
  });
};

describe("DecisionCard", () => {
  it("puts Keep before the verb, and the verb last", () => {
    render(<DecisionCard {...base()} />);
    const names = within(screen.getByRole("group", { name: "Actions" }))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Open in Edit", "Keep", "Later", "Cut"]);
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

  it("offers Hear on an unsure word and saves no empty text", async () => {
    const onHear = vi.fn();
    const onFix = vi.fn();
    render(
      <DecisionCard
        {...base()}
        kind="unsure-word"
        unsure={{ word: "uncle", guess: "uncle", onFix, onHear }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Hear" }));
    expect(onHear).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
    await userEvent.clear(
      screen.getByRole("textbox", { name: "Corrected text for “uncle”" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onFix).not.toHaveBeenCalled();
  });

  it("carries Open in Edit on the phone's unsure card, where the dock has none", async () => {
    const onOpenInEdit = vi.fn();
    const props = {
      ...base(),
      kind: "unsure-word" as const,
      unsure: { word: "uncle", guess: "uncle", onFix: vi.fn() },
      onOpenInEdit,
    };
    const { rerender } = render(<DecisionCard {...props} layout="phone" />);
    await userEvent.click(screen.getByRole("button", { name: "Open in Edit" }));
    expect(onOpenInEdit).toHaveBeenCalledTimes(1);
    rerender(<DecisionCard {...props} layout="phone" canEdit={false} />);
    expect(screen.queryByRole("button", { name: "Open in Edit" })).toBeNull();
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

  it("gives a guest Hear and Comment, and Open in Edit only with canEdit", async () => {
    const props = { ...base(), onComment: vi.fn() };
    const { rerender } = render(<DecisionCard {...props} readOnly />);
    expect(screen.queryByRole("button", { name: "Cut" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Edit" })).toBeNull();
    expect(screen.getAllByRole("group", { name: "Audition" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(props.onComment).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("slider", { name: "End of the change" }),
    ).toHaveAttribute("aria-readonly", "true");
    rerender(<DecisionCard {...props} readOnly canEdit />);
    expect(
      screen.getByRole("button", { name: "Open in Edit" }),
    ).toBeInTheDocument();
  });

  it("keeps Hear in the dock for a guest on phone", () => {
    render(<DecisionCard {...base()} readOnly layout="phone" />);
    const dock = screen.getByRole("group", { name: "Actions" });
    expect(
      within(dock).getByRole("group", { name: "Audition" }),
    ).toBeInTheDocument();
    expect(
      within(dock).getByRole("button", { name: "Comment" }),
    ).toBeInTheDocument();
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

  it("does not let a swipe decide a cut held back by an unsure word", () => {
    const props = base();
    const { container } = render(
      <DecisionCard
        {...props}
        layout="phone"
        unsure={{ word: "uncle", guess: "uncle", onFix: vi.fn() }}
      />,
    );
    const body = container.querySelector(".sys-decision-body") as Element;
    fireEvent.pointerDown(body, {
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(body, { clientX: 220, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(body, { clientX: 220, clientY: 100, pointerId: 1 });
    expect(props.onVerb).not.toHaveBeenCalled();
  });

  it("still keeps and moves on by swipe while the cut is held", () => {
    const props = base();
    const { container } = render(
      <DecisionCard
        {...props}
        layout="phone"
        unsure={{ word: "uncle", guess: "uncle", onFix: vi.fn() }}
      />,
    );
    const body = container.querySelector(".sys-decision-body") as Element;
    swipe(body, 120, 0);
    expect(props.onVerb).not.toHaveBeenCalled();
    swipe(body, -120, 0);
    expect(props.onKeep).toHaveBeenCalledOnce();
    swipe(body, 0, -120);
    expect(props.onLater).toHaveBeenCalledOnce();
  });

  it("shows no verb reveal while the cut is held", () => {
    const { container } = render(
      <DecisionCard
        {...base()}
        layout="phone"
        unsure={{ word: "uncle", guess: "uncle", onFix: vi.fn() }}
      />,
    );
    const body = container.querySelector(".sys-decision-body") as Element;
    fireEvent.pointerDown(body, {
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(body, { clientX: 220, clientY: 100, pointerId: 1 });
    expect(container.querySelector(".sys-decision-reveal")).toBeNull();
  });

  it("does not swipe for a guest on phone", () => {
    const props = base();
    const { container } = render(
      <DecisionCard {...props} layout="phone" readOnly />,
    );
    const body = container.querySelector(".sys-decision-body") as Element;
    swipe(body, 120, 0);
    swipe(body, -120, 0);
    swipe(body, 0, -120);
    expect(props.onVerb).not.toHaveBeenCalled();
    expect(props.onKeep).not.toHaveBeenCalled();
    expect(props.onLater).not.toHaveBeenCalled();
  });

  it("does not let a tap on the waveform flip A/B", () => {
    const props = base();
    render(<DecisionCard {...props} />);
    const handle = screen.getByRole("slider", { name: "End of the change" });
    fireEvent.pointerDown(handle, { clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(props.audition?.onSide).not.toHaveBeenCalled();
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

describe("DecisionCard without a waveform", () => {
  it("plays the A/B from change", async () => {
    const onHear = vi.fn();
    render(
      <DecisionCard
        {...base()}
        waveform={undefined}
        change={{ start: 10, end: 11 }}
        audition={{ side: "B", onSide: vi.fn(), onHear }}
      />,
    );
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onHear).toHaveBeenCalledWith("A", [{ start: 7, end: 14 }]);
  });

  it("shows no A/B without a change", () => {
    render(<DecisionCard {...base()} waveform={undefined} />);
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
  });
});

describe("DecisionCard verb", () => {
  it("replaces the kind's primary and drops the duplicate Keep", async () => {
    const onVerb = vi.fn();
    render(
      <DecisionCard {...base()} kind="sound" verb="keep" onVerb={onVerb} />,
    );
    const keeps = screen.getAllByRole("button", { name: /^Keep/ });
    expect(keeps).toHaveLength(1);
    await userEvent.click(keeps[0] as HTMLElement);
    expect(onVerb).toHaveBeenCalledTimes(1);
  });

  it("labels the override, not the kind's own label", () => {
    render(
      <DecisionCard
        {...base()}
        kind="unsure-word"
        unsure={undefined}
        verb="cut"
      />,
    );
    expect(screen.getByRole("button", { name: /^Cut/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Looks right/ })).toBeNull();
  });

  it("reveals the override's icon on a swipe, not the kind's", () => {
    const { container } = render(
      <DecisionCard {...base()} verb="shorten" layout="phone" />,
    );
    const body = container.querySelector(".sys-decision-body") as Element;
    fireEvent.pointerDown(body, {
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(body, { clientX: 220, clientY: 100, pointerId: 1 });
    const icon = (el: Element | null) => el?.querySelector("svg")?.innerHTML;
    const reveal = container.querySelector(".sys-decision-reveal");
    expect(icon(reveal)).toBe(
      icon(screen.getByRole("button", { name: /^Shorten/ })),
    );
  });

  it("disables the primary and the swipe for a given reason", () => {
    const props = base();
    const { container } = render(
      <DecisionCard {...props} layout="phone" verbDisabledReason="Open it." />,
    );
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    swipe(container.querySelector(".sys-decision-body") as Element, 120, 0);
    expect(props.onVerb).not.toHaveBeenCalled();
  });

  it("links the blocked primary to the visible reason", () => {
    render(<DecisionCard {...base()} verbDisabledReason="Open it." />);
    const note = screen.getByText("Open it.");
    expect(note.id).not.toBe("");
    expect(screen.getByRole("button", { name: "Cut" })).toHaveAttribute(
      "aria-describedby",
      note.id,
    );
  });

  it("links the held Cut to a rendered note while an unsure word is unchecked", () => {
    render(
      <DecisionCard
        {...base()}
        unsure={{
          word: "uncle",
          guess: "uncle",
          onFix: vi.fn(),
          onLooksRight: vi.fn(),
        }}
      />,
    );
    const id = screen
      .getByRole("button", { name: "Cut" })
      .getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const note = document.getElementById(id as string);
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent("Check the unsure word first.");
  });

  it("offers no Keep without a Keep handler", () => {
    render(<DecisionCard {...base()} onKeep={undefined} />);
    expect(screen.queryByRole("button", { name: /^Keep/ })).toBeNull();
  });

  it("compact drops Open in Edit, keeps A/B in the body and does not swipe", () => {
    const props = base();
    const { container } = render(<DecisionCard {...props} layout="compact" />);
    expect(container.querySelector(".sys-decision")).toHaveAttribute(
      "data-layout",
      "compact",
    );
    const bar = screen.getByRole("group", { name: "Actions" });
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Keep", "Later", "Cut"]);
    expect(within(bar).queryByRole("group", { name: "Audition" })).toBeNull();
    expect(screen.getByRole("group", { name: "Audition" })).toBeInTheDocument();
    swipe(container.querySelector(".sys-decision-body") as Element, 100, 0);
    expect(props.onVerb).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Open in/ })).toBeNull();
  });

  it("compact still holds the verb behind an unsure word and lets a guest comment", async () => {
    const props = base();
    const { rerender } = render(
      <DecisionCard
        {...props}
        layout="compact"
        unsure={{ word: "uncl", guess: "uncle", onFix: vi.fn() }}
      />,
    );
    const cut = screen.getByRole("button", { name: "Cut" });
    expect(cut).toBeDisabled();
    await userEvent.click(cut);
    expect(props.onVerb).not.toHaveBeenCalled();
    const describedBy = cut.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const note = document.getElementById(describedBy as string);
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent("Check the unsure word first.");
    rerender(<DecisionCard {...base()} layout="compact" readOnly />);
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cut" })).toBeNull();
  });
});
