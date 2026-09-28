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
          trackLabel="Mira"
          muteState="saved"
          solo
          editsMix={false}
          onMute={onMute}
          onSolo={onSolo}
        />
      </div>,
    );
    expect(screen.getByRole("button", { name: "Mute Mira" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Solo Mira" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const name of ["Mute Mira", "Solo Mira"]) {
      const glyph = screen.getByRole("button", { name }).textContent ?? "";
      expect(glyph).not.toBe("");
      expect(name.startsWith(glyph)).toBe(true);
    }
    await expectNoA11yViolations(container);
  });
});
