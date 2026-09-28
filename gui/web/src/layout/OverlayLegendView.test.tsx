import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { layerVisibility } from "../test/fixtures";
import { OverlayLegendView } from "./OverlayLegendView";

describe("OverlayLegendView", () => {
  it("renders the Timeline layers group from props", async () => {
    const { container } = render(
      <OverlayLegendView layers={layerVisibility()} onLayerChange={vi.fn()} />,
    );
    expect(screen.getByRole("group", { name: "Timeline layers" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("labels rows Pending edits and Volume envelope", () => {
    render(
      <OverlayLegendView layers={layerVisibility()} onLayerChange={vi.fn()} />,
    );
    expect(screen.getByLabelText("Pending edits")).toBeTruthy();
    expect(screen.getByLabelText("Volume envelope")).toBeTruthy();
    expect(screen.queryByLabelText("Edits")).toBeNull();
    expect(screen.queryByLabelText("Levels")).toBeNull();
  });

  it("calls onLayerChange when Volume envelope is toggled", async () => {
    const onLayerChange = vi.fn();
    render(
      <OverlayLegendView
        layers={layerVisibility()}
        onLayerChange={onLayerChange}
      />,
    );
    await userEvent.click(screen.getByLabelText("Volume envelope"));
    expect(onLayerChange).toHaveBeenCalledWith("showLevels", false);
  });

  it("gives every row a swatch", () => {
    const { container } = render(
      <OverlayLegendView layers={layerVisibility()} onLayerChange={vi.fn()} />,
    );
    const rows = container.querySelectorAll(".overlay-legend-item");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.querySelector(".overlay-legend-swatch")).toBeTruthy();
    }
    expect(
      container.querySelector(".overlay-legend-swatch--pending"),
    ).toBeTruthy();
    expect(
      container.querySelector(".overlay-legend-swatch--envelope"),
    ).toBeTruthy();
    expect(
      container.querySelector(".overlay-legend-swatch--markers"),
    ).toBeTruthy();
    expect(
      container.querySelector(".overlay-legend-swatch--comments"),
    ).toBeTruthy();
  });

  it("renders menuitemcheckbox rows inside a menu host", async () => {
    const { container } = render(
      <div role="menu" aria-label="View menu">
        <OverlayLegendView
          menu
          layers={layerVisibility()}
          onLayerChange={vi.fn()}
        />
      </div>,
    );
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(6);
    await expectNoA11yViolations(container);
  });
});
