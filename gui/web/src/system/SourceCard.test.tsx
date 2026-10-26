import { render, screen } from "@testing-library/react";
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
    render(<Card voices={4} />);
    expect(screen.getByRole("region", { name: "Voice 2" })).toBeVisible();
    const order = [
      "Speaker name",
      "Hear voice 2",
      "Fewer voices",
      "More voices",
      "Split",
      "Remove",
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
    await userEvent.type(screen.getByLabelText("Speaker name"), "Maya");
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

  it("steps the number of voices within 2 and 8, with the reason shown", async () => {
    const onVoices = vi.fn();
    const { rerender } = render(
      <SourceCard
        state="ready"
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
    const fewer = screen.getByRole("button", { name: "Fewer voices" });
    expect(fewer).toHaveAttribute("aria-disabled", "true");
    expect(fewer).not.toBeDisabled();
    await userEvent.click(fewer);
    expect(onVoices).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "More voices" }));
    expect(onVoices).toHaveBeenCalledWith(3);
    rerender(
      <SourceCard
        state="ready"
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
    await userEvent.click(screen.getByRole("button", { name: "More voices" }));
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
      screen.getByRole("menuitem", { name: "Replace audio..." }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Merge" }));
    expect(onMerge).toHaveBeenCalled();
  });

  it.each([
    ["uploading", "Uploading"],
    ["probing", "Checking file"],
    ["ready", "Ready"],
    ["needs-name", "Needs a name"],
    ["split-prompt", "Sounds like more than one person"],
  ] as const)("says %s in words", (state, text) => {
    render(<Card state={state} progress={0.3} />);
    expect(screen.getByText(text)).toBeVisible();
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
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onRetry).toHaveBeenCalled();
    expect(onDetails).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Hear/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove" })).toBeVisible();
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
});
