import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TransportPlayControls } from "./TransportPlayControls";

describe("TransportPlayControls", () => {
  it("labels Play/Pause from state and runs the handlers", () => {
    const onTogglePlay = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <TransportPlayControls
        playing={false}
        onTogglePlay={onTogglePlay}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onTogglePlay).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <TransportPlayControls
        playing
        onTogglePlay={onTogglePlay}
        onStop={onStop}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute(
      "title",
      "Stop (K)",
    );
    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause).toHaveAttribute("title", "Pause (Space)");
    expect(pause).toHaveAttribute("data-playing", "true");
    expect(pause).toHaveClass("ui-control", "play-btn");
  });

  it("disables both with the reason on Play", () => {
    render(
      <TransportPlayControls
        playing={false}
        disabled
        disabledTitle="Import audio to play"
        onTogglePlay={() => undefined}
        onStop={() => undefined}
      />,
    );
    const play = screen.getByRole("button", { name: "Play" });
    expect(play).toBeDisabled();
    expect(play).toHaveAttribute("title", "Import audio to play");
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });
});
