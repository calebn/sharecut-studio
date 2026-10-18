import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type BleedAttenuationRegion,
  bleedAttenuationRegionKey,
} from "../edit/bleedAttenuation";
import { expectNoA11yViolations } from "../test/a11y";
import { BleedAttenuationOverlay } from "./BleedAttenuationOverlay";

const region: BleedAttenuationRegion<{ seal: string }> = {
  trackId: "mira",
  occurrenceId: "one-copy",
  kind: "late_gate",
  sourceSpan: { start: 20, end: 21 },
  timelineSpan: { start: 5, end: 6 },
  restore: {
    state: "available",
    target: { seal: "opaque" },
    sourceSpan: { start: 20, end: 21 },
  },
};
describe("BleedAttenuationOverlay", () => {
  it("uses supplied geometry and selects the occurrence without triggering the enclosing clip", async () => {
    const onSelect = vi.fn();
    const onClipClick = vi.fn();
    const onClipDown = vi.fn();
    const { container } = render(
      <div onClick={onClipClick} onPointerDown={onClipDown} role="presentation">
        <BleedAttenuationOverlay
          regions={[{ region, leftPx: 24, widthPx: 60 }]}
          selectedKey={bleedAttenuationRegionKey(region)}
          onSelect={onSelect}
        />
      </div>,
    );
    const button = screen.getByRole("button", {
      name: /^Automatic reduction,/,
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".bleed-attenuation-band")).toHaveStyle({
      left: "24px",
      width: "60px",
    });
    fireEvent.pointerDown(button);
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(
      bleedAttenuationRegionKey(region),
    );
    expect(onClipDown).not.toHaveBeenCalled();
    expect(onClipClick).not.toHaveBeenCalled();
  });
  it("supports native keyboard selection and leaves controlled selection unchanged", async () => {
    const onSelect = vi.fn();
    render(
      <BleedAttenuationOverlay
        regions={[{ region, leftPx: 0, widthPx: 1 }]}
        selectedKey={null}
        onSelect={onSelect}
      />,
    );
    await userEvent.tab();
    const button = screen.getByRole("button");
    expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter} ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
  it("labels each automatic kind and remains empty without regions", () => {
    const { rerender } = render(
      <BleedAttenuationOverlay
        regions={[
          {
            region: { ...region, kind: "bleed_mute:off_speaker" },
            leftPx: 10,
            widthPx: 40,
          },
        ]}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Automatic speaker mute,/ }),
    ).toBeVisible();
    rerender(
      <BleedAttenuationOverlay
        regions={[]}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
  it("uses the shared accessibility check", async () => {
    const { container } = render(
      <BleedAttenuationOverlay
        regions={[{ region, leftPx: 0, widthPx: 60 }]}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
