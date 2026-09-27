import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { TrackMuteSoloButtonsView } from "./TrackMuteSoloButtonsView";

describe("TrackMuteSoloButtonsView", () => {
  it("renders prop-driven saved mute and solo without app state", async () => {
    const onMute = vi.fn();
    const onSolo = vi.fn();
    const { container } = render(
      <div role="group" aria-label="Mira mixer">
        <TrackMuteSoloButtonsView
          trackId="mira"
          muteState="saved"
          solo
          editsMix={false}
          onMute={onMute}
          onSolo={onSolo}
        />
      </div>,
    );
    expect(screen.getByRole("button", { name: "M" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "S" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectNoA11yViolations(container);
  });
});
