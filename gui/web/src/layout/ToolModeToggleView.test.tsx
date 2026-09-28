import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ToolModeToggleView } from "./ToolModeToggleView";

function actions() {
  return {
    onSelect: vi.fn(),
    onBlade: vi.fn(),
    onToggleComment: vi.fn(),
  };
}

describe("ToolModeToggleView", () => {
  it("reflects the select tool via aria-pressed", async () => {
    const { container } = render(
      <ToolModeToggleView
        structuralToolsAllowed
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Blade" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Comment" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expectNoA11yViolations(container);
  });

  it("reflects the blade tool via aria-pressed", () => {
    render(
      <ToolModeToggleView
        structuralToolsAllowed
        toolMode="blade"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Blade" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows comment mode as pressed and both tools as unpressed", () => {
    render(
      <ToolModeToggleView
        structuralToolsAllowed
        toolMode="select"
        commentMode
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Comment" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("titles Select, Blade and Comment with their shortcuts", () => {
    render(
      <ToolModeToggleView
        structuralToolsAllowed
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        selectAriaKeyShortcuts="V"
        bladeTitle="Blade tool (C)"
        bladeAriaKeyShortcuts="C"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        commentAriaKeyShortcuts="Meta+Shift+C"
        {...actions()}
      />,
    );
    const select = screen.getByRole("button", { name: "Select" });
    expect(select).toHaveAttribute("title", "Select tool (V)");
    expect(select).toHaveAttribute("aria-keyshortcuts", "V");
    const blade = screen.getByRole("button", { name: "Blade" });
    expect(blade).toHaveAttribute(
      "title",
      "Blade tool (C): split at click or playhead",
    );
    expect(blade).toHaveAttribute("aria-keyshortcuts", "C");
    const comment = screen.getByRole("button", { name: "Comment" });
    expect(comment).toHaveAttribute(
      "title",
      "Comment mode: click/drag ruler to anchor feedback (⌘⇧C)",
    );
    expect(comment).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+C");
  });

  it("renders inside a group with the shared segmented classes", () => {
    render(
      <ToolModeToggleView
        structuralToolsAllowed
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        {...actions()}
      />,
    );
    const group = screen.getByRole("group", { name: "Timeline tool" });
    expect(group.classList.contains("ui-segmented")).toBe(true);
    expect(group.classList.contains("tool-mode-toggle")).toBe(true);
  });

  it("omits Comment and adds the compact class when compact", () => {
    render(
      <ToolModeToggleView
        compact
        structuralToolsAllowed
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    const group = screen.getByRole("group", { name: "Timeline tool" });
    expect(group.classList.contains("tool-mode-toggle--compact")).toBe(true);
  });

  it("renders only Comment when structural tools are not allowed", () => {
    render(
      <ToolModeToggleView
        structuralToolsAllowed={false}
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Blade" })).toBeNull();
    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
  });

  it("calls each callback on click", async () => {
    const user = userEvent.setup();
    const cbs = actions();
    render(
      <ToolModeToggleView
        structuralToolsAllowed
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Comment mode: click/drag ruler to anchor feedback (⌘⇧C)"
        {...cbs}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: "Blade" }));
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(cbs.onSelect).toHaveBeenCalledTimes(1);
    expect(cbs.onBlade).toHaveBeenCalledTimes(1);
    expect(cbs.onToggleComment).toHaveBeenCalledTimes(1);
  });
});
