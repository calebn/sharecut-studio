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

  it("calls onLayerChange when Levels is toggled", async () => {
    const onLayerChange = vi.fn();
    render(
      <OverlayLegendView
        layers={layerVisibility()}
        onLayerChange={onLayerChange}
      />,
    );
    await userEvent.click(screen.getByLabelText("Levels"));
    expect(onLayerChange).toHaveBeenCalledWith("showLevels", false);
  });

  it("shows + Chapter only when markers are visible and a handler is passed", () => {
    const { rerender } = render(
      <OverlayLegendView layers={layerVisibility()} onLayerChange={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "+ Chapter" })).toBeNull();

    rerender(
      <OverlayLegendView
        layers={layerVisibility()}
        onLayerChange={vi.fn()}
        onAddChapter={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "+ Chapter" })).toBeTruthy();

    rerender(
      <OverlayLegendView
        layers={layerVisibility({ showMarkers: false })}
        onLayerChange={vi.fn()}
        onAddChapter={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "+ Chapter" })).toBeNull();
  });

  it("disables + Chapter and sets aria-busy while addChapterBusy", async () => {
    const onAddChapter = vi.fn();
    const { container, rerender } = render(
      <OverlayLegendView
        layers={layerVisibility()}
        onLayerChange={vi.fn()}
        onAddChapter={onAddChapter}
        addChapterBusy
      />,
    );
    const button = screen.getByRole("button", { name: "+ Chapter" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(button);
    expect(onAddChapter).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);

    rerender(
      <OverlayLegendView
        layers={layerVisibility()}
        onLayerChange={vi.fn()}
        onAddChapter={onAddChapter}
      />,
    );
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("renders menuitemcheckbox / menuitem rows inside a menu host", async () => {
    const { container } = render(
      <div role="menu" aria-label="View menu">
        <OverlayLegendView
          menu
          layers={layerVisibility()}
          onLayerChange={vi.fn()}
          onAddChapter={vi.fn()}
        />
      </div>,
    );
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(6);
    expect(screen.getByRole("menuitem", { name: "+ Chapter" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
