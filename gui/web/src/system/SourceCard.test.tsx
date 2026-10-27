import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SourceCard, type SourceCardProps } from "./SourceCard";

function Card(props: Partial<SourceCardProps>) {
  const [name, setName] = useState(props.name ?? "");
  return (
    <SourceCard
      state="ready"
      index={2}
      fileName="track-2.wav"
      audioTime="5:11 of audio"
      onRemove={vi.fn()}
      {...props}
      name={name}
      onName={setName}
    />
  );
}

describe("SourceCard", () => {
  it("is a section whose controls are separate tab stops in order", async () => {
    render(<Card voices={4} canSplit onMoveUp={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Voice 2" })).toBeVisible();
    const order = [
      "Speaker name for voice 2",
      "Hear voice 2",
      "Fewer voices for voice 2",
      "More voices for voice 2",
      "Split voice 2",
      "Remove voice 2",
      "More for voice 2",
    ];
    for (const label of order) {
      await userEvent.tab();
      expect(document.activeElement).toHaveAccessibleName(label);
    }
  });

  it("changes the Hear label from the index to the name", async () => {
    render(<Card />);
    expect(screen.getByRole("button", { name: /^Hear/ })).toHaveAccessibleName(
      "Hear voice 2",
    );
    await userEvent.type(screen.getByLabelText(/^Speaker name/), "Maya");
    expect(screen.getByRole("button", { name: /^Hear/ })).toHaveAccessibleName(
      "Hear Maya",
    );
    expect(screen.getByRole("region", { name: "Voice 2, Maya" })).toBeVisible();
  });

  it("keeps one Hear label while playing and presses it", () => {
    render(<Card name="Maya" playing />);
    const hear = screen.getByRole("button", { name: /^Hear/ });
    expect(hear).toHaveAccessibleName("Hear Maya");
    expect(hear).toHaveAttribute("aria-pressed", "true");
  });

  it("omits aria-pressed from Hear while idle", () => {
    render(<Card name="Maya" playing={false} />);
    expect(screen.getByRole("button", { name: /^Hear/ })).not.toHaveAttribute(
      "aria-pressed",
    );
  });

  it("does not fill Split with the accent, even when prompted", () => {
    render(<Card name="Maya" state="split-prompt" />);
    expect(screen.getByRole("button", { name: "Split Maya" })).not.toHaveClass(
      "primary",
    );
  });

  it("steps the number of voices within 2 and 8, with the reason shown", async () => {
    const onVoices = vi.fn();
    const { rerender } = render(
      <SourceCard
        state="ready"
        canSplit
        index={1}
        name="Maya"
        onName={vi.fn()}
        fileName="a.wav"
        onRemove={vi.fn()}
        voices={2}
        onVoices={onVoices}
      />,
    );
    const group = screen.getByRole("group", { name: "Number of voices" });
    expect(group).toBeVisible();
    expect(screen.getByText("Two is the fewest")).toBeVisible();
    const fewer = screen.getByRole("button", { name: /^Fewer voices/ });
    expect(fewer).toHaveAttribute("aria-disabled", "true");
    expect(fewer).not.toBeDisabled();
    expect(fewer).toHaveAccessibleDescription("Two is the fewest");
    expect(
      screen.getByRole("button", { name: /^More voices/ }),
    ).not.toHaveAttribute("aria-describedby");
    await userEvent.click(fewer);
    expect(onVoices).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^More voices/ }));
    expect(onVoices).toHaveBeenCalledWith(3);
    rerender(
      <SourceCard
        state="ready"
        canSplit
        index={1}
        name="Maya"
        onName={vi.fn()}
        fileName="a.wav"
        onRemove={vi.fn()}
        voices={8}
        onVoices={onVoices}
      />,
    );
    expect(screen.getByText("Eight is the most")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^More voices/ }),
    ).toHaveAccessibleDescription("Eight is the most");
    await userEvent.click(screen.getByRole("button", { name: /^More voices/ }));
    expect(onVoices).toHaveBeenCalledTimes(1);
    expect(group.querySelector("output")).toHaveTextContent("8");
    expect(group.querySelector("output")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("offers Replace audio and Merge from the More menu", async () => {
    const onMerge = vi.fn();
    render(<Card name="Maya" onMerge={onMerge} />);
    await userEvent.click(screen.getByRole("button", { name: /^More for/ }));
    expect(
      screen.getByRole("menuitem", { name: "Replace audio for Maya" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Merge for Maya" }),
    );
    expect(onMerge).toHaveBeenCalled();
  });

  it.each([
    ["uploading", "Uploading"],
    ["probing", "Checking file"],
    ["ready", "Ready"],
    ["needs-name", "Needs a name"],
    ["split-prompt", "One recording of several people?"],
    ["splitting", "Finding voices"],
  ] as const)("says %s in words", (state, text) => {
    render(<Card state={state} progress={0.3} />);
    expect(screen.getByText(text)).toBeVisible();
  });

  it("says the upload bar in words", () => {
    render(<Card state="uploading" progress={0.62} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "62 percent",
    );
  });

  it("reads voice time as audio, never a share", () => {
    render(<Card state="needs-name" />);
    expect(screen.getByText("5:11 of audio")).toBeVisible();
    expect(screen.queryByText(/share/i)).toBeNull();
  });

  it("shows the plain cause, Try again and Details when it failed", async () => {
    const onRetry = vi.fn();
    const onDetails = vi.fn();
    render(
      <Card
        state="failed"
        cause="This file has no audio in it."
        onRetry={onRetry}
        onDetails={onDetails}
      />,
    );
    expect(screen.getByText("This file has no audio in it.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /^Try again/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Details/ }));
    expect(onRetry).toHaveBeenCalled();
    expect(onDetails).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Hear/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove voice 2" }),
    ).toBeVisible();
  });

  it("hides the waveform from assistive tech", () => {
    const { container } = render(<Card />);
    expect(container.querySelector(".sys-source-wave")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("says another voice has the same name", () => {
    render(<Card name="Sam" sameNameAs="Sam" />);
    expect(screen.getByText("Another voice is also called Sam.")).toBeVisible();
  });

  it("shows the voice count and Split only when the card can split", () => {
    const { rerender } = render(<Card />);
    expect(
      screen.queryByRole("group", { name: "Number of voices" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Split/ })).toBeNull();
    rerender(<Card state="split-prompt" />);
    expect(
      screen.getByRole("group", { name: "Number of voices" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Split voice 2" })).toBeVisible();
    rerender(<Card state="split-prompt" canSplit={false} />);
    expect(screen.queryByRole("button", { name: /^Split/ })).toBeNull();
    rerender(<Card canSplit />);
    expect(screen.getByRole("button", { name: "Split voice 2" })).toBeVisible();
  });

  it("says the split question once", () => {
    render(<Card state="split-prompt" />);
    expect(
      screen.getAllByText("One recording of several people?"),
    ).toHaveLength(1);
  });

  it("puts the card's name in Remove, Split, Replace and Move", async () => {
    render(
      <Card name="Maya" canSplit onMoveUp={vi.fn()} onMoveDown={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Remove Maya" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Split Maya" })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Maya" }),
    );
    for (const name of [
      "Replace audio for Maya",
      "Move up for Maya",
      "Move down for Maya",
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeVisible();
    }
  });

  it("moves a card up and down from the More menu", async () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    render(<Card name="Maya" onMoveUp={onMoveUp} onMoveDown={onMoveDown} />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for Maya" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /^Move up/ }));
    expect(onMoveUp).toHaveBeenCalledOnce();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Maya" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /^Move down/ }));
    expect(onMoveDown).toHaveBeenCalledOnce();
  });

  it("leaves out Move at the ends of the session", async () => {
    render(<Card name="Maya" onMoveDown={vi.fn()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for Maya" }),
    );
    expect(screen.queryByRole("menuitem", { name: /^Move up/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /^Move down/ })).toBeVisible();
  });

  it("shows progress and Cancel while splitting, and no split controls", async () => {
    const onCancelSplit = vi.fn();
    render(
      <Card
        state="splitting"
        progress={0.4}
        splitDetail="Finding voices · 1 of 3"
        onCancelSplit={onCancelSplit}
        canSplit
      />,
    );
    expect(screen.getByText("Finding voices · 1 of 3")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(
      screen.queryByRole("group", { name: "Number of voices" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Split/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^More for/ })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /^Cancel splitting/ }),
    );
    expect(onCancelSplit).toHaveBeenCalledOnce();
  });

  it.each([
    [-0.2, "0%", "0"],
    [1.4, "100%", "100"],
    [Number.NaN, "0%", "0"],
  ])("holds upload progress %s to 0..100", (progress, text, now) => {
    render(<Card state="uploading" progress={progress} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      now,
    );
  });

  it("tells two cards with one name apart in every control name", async () => {
    render(<Card name="Sam" sameNameAs="Sam" onMerge={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Hear/ })).toHaveAccessibleName(
      "Hear Sam, voice 2",
    );
    expect(
      screen.getByRole("button", { name: "Remove Sam, voice 2" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Sam, voice 2" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Merge for Sam, voice 2" }),
    ).toBeVisible();
  });

  it("returns focus to the More button on Escape", async () => {
    render(<Card name="Sam" onMoveUp={vi.fn()} />);
    const more = screen.getByRole("button", { name: "More for Sam" });
    await userEvent.click(more);
    const first = await screen.findByRole("menuitem", {
      name: "Replace audio for Sam",
    });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute("role", "menuitem"),
    );
    act(() => first.focus());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it.each([
    ["with Enter", "{Enter}"],
    ["with a click", null],
  ])("returns focus to the More button after a choice %s", async (_, key) => {
    const onMoveUp = vi.fn();
    render(<Card name="Sam" onMoveUp={onMoveUp} />);
    const more = screen.getByRole("button", { name: "More for Sam" });
    await userEvent.click(more);
    const item = await screen.findByRole("menuitem", {
      name: "Move up for Sam",
    });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute("role", "menuitem"),
    );
    if (key) {
      act(() => item.focus());
      await userEvent.keyboard(key);
    } else {
      await userEvent.click(item);
    }
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("caps the speaker name at what the server accepts", () => {
    render(<Card />);
    expect(screen.getByLabelText(/^Speaker name/)).toHaveAttribute(
      "maxlength",
      "80",
    );
  });
});

describe("SourceCard focus", () => {
  function Stage({ state }: { state: SourceCardProps["state"] }) {
    return (
      <SourceCard
        state={state}
        index={1}
        name=""
        onName={vi.fn()}
        fileName="a.wav"
        onRemove={vi.fn()}
        onSplit={vi.fn()}
        onCancelSplit={vi.fn()}
        onRetry={vi.fn()}
        progress={0.2}
        splitDetail="1 of 9"
      />
    );
  }

  it("stays in the card when Split replaces the controls", async () => {
    const { rerender } = render(<Stage state="split-prompt" />);
    const card = screen.getByRole("region", { name: "Voice 1" });
    screen.getByRole("button", { name: "Split voice 1" }).focus();
    await userEvent.keyboard("{Enter}");
    rerender(<Stage state="splitting" />);
    expect(document.activeElement).toBe(card);
  });

  it("stays in the card when Cancel splitting returns to the prompt", async () => {
    const { rerender } = render(<Stage state="splitting" />);
    const card = screen.getByRole("region", { name: "Voice 1" });
    screen.getByRole("button", { name: "Cancel splitting voice 1" }).focus();
    await userEvent.keyboard("{Enter}");
    rerender(<Stage state="split-prompt" />);
    expect(document.activeElement).toBe(card);
  });

  it("stays in the card when Try again starts checking the file", async () => {
    const { rerender } = render(<Stage state="failed" />);
    const card = screen.getByRole("region", { name: "Voice 1" });
    screen.getByRole("button", { name: "Try again for voice 1" }).focus();
    await userEvent.keyboard("{Enter}");
    rerender(<Stage state="probing" />);
    expect(document.activeElement).toBe(card);
  });

  it("leaves focus alone when it is on a control that stays", () => {
    const { rerender } = render(<Stage state="split-prompt" />);
    screen.getByRole("button", { name: "Remove voice 1" }).focus();
    rerender(<Stage state="splitting" />);
    expect(
      screen.getByRole("button", { name: "Remove voice 1" }),
    ).toHaveFocus();
  });
});
