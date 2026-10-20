import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { TransportPlayControls } from "./TransportPlayControls";

describe("TransportPlayControls", () => {
  it("labels Play/Pause from state and runs the handlers", () => {
    const onTogglePlay = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <TransportPlayControls
        playing={false}
        availability={{ togglePlay: undefined, stop: undefined }}
        onTogglePlay={onTogglePlay}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
    expect(onTogglePlay).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <TransportPlayControls
        playing
        availability={{ togglePlay: undefined, stop: undefined }}
        onTogglePlay={onTogglePlay}
        onStop={onStop}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Stop playback" }),
    ).toHaveAttribute("title", "Stop and return to where playback started (K)");
    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause).toHaveAttribute("title", "Pause (Space)");
    expect(pause).toHaveAttribute("data-playing", "true");
    expect(pause).toHaveClass("ui-control", "play-btn");
  });

  it("shows the unavailable reason for both focusable controls", async () => {
    const onTogglePlay = vi.fn();
    const onStop = vi.fn();
    const { container } = render(
      <TransportPlayControls
        playing={false}
        availability={{
          togglePlay: "Import audio to play.",
          stop: "Import audio to play.",
        }}
        onTogglePlay={onTogglePlay}
        onStop={onStop}
      />,
    );
    const play = screen.getByRole("button", { name: "Play" });
    const stop = screen.getByRole("button", { name: "Stop playback" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Import audio to play.",
    );
    for (const button of [play, stop]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      expect(button).toHaveAccessibleDescription("Import audio to play.");
      expect(button.getAttribute("aria-describedby")).toBe(
        screen.getByRole("status").id,
      );
    }
    expect(play).toHaveAttribute("data-presence-anchor", "transport:play");
    expect(stop).toHaveAttribute("data-presence-anchor", "transport:stop");
    fireEvent.click(play);
    fireEvent.click(stop);
    expect(onTogglePlay).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("blocks pointer and keyboard activation, retains focus, and recovers", async () => {
    const user = userEvent.setup();
    const onTogglePlay = vi.fn();
    const onStop = vi.fn();
    const props = { playing: false, onTogglePlay, onStop };
    const { rerender } = render(
      <TransportPlayControls
        {...props}
        availability={{
          togglePlay: "Loading project…",
          stop: "Loading project…",
        }}
      />,
    );
    const play = screen.getByRole("button", { name: "Play" });
    play.focus();
    expect(document.activeElement).toBe(play);

    await user.pointer({ keys: "[TouchA]", target: play });
    await user.keyboard(" ");
    expect(onTogglePlay).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();

    rerender(
      <TransportPlayControls
        {...props}
        availability={{ togglePlay: undefined, stop: undefined }}
      />,
    );
    expect(screen.getByRole("button", { name: "Play" })).toBe(play);
    expect(document.activeElement).toBe(play);
    expect(play).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await user.keyboard(" ");
    expect(onTogglePlay).toHaveBeenCalledOnce();
  });
  it("describes each unavailable action independently and normalizes blank reasons", async () => {
    const { container } = render(
      <TransportPlayControls
        playing={false}
        availability={{ togglePlay: "Import audio to play.", stop: " " }}
        onTogglePlay={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Play" }),
    ).toHaveAccessibleDescription("Import audio to play.");
    const stop = screen.getByRole("button", { name: "Stop playback" });
    expect(stop).toHaveAccessibleDescription(
      "This action is unavailable right now.",
    );
    expect(stop).toHaveAttribute(
      "title",
      "This action is unavailable right now.",
    );
    expect(screen.getAllByRole("status")).toHaveLength(2);
    await expectNoA11yViolations(container);
  });
});
