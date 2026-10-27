import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
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
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Blade tool" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Toggle comment mode" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expectNoA11yViolations(container);
  });

  it("reflects the blade tool via aria-pressed", () => {
    render(
      <ToolModeToggleView
        toolMode="blade"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Blade tool" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows comment mode as pressed and both tools as unpressed", () => {
    render(
      <ToolModeToggleView
        toolMode="select"
        commentMode
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Toggle comment mode" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("titles Select, Blade and Comment with their shortcuts", () => {
    render(
      <ToolModeToggleView
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        selectAriaKeyShortcuts="V"
        bladeTitle="Blade tool (C)"
        bladeAriaKeyShortcuts="C"
        commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
        commentAriaKeyShortcuts="Meta+Shift+C"
        {...actions()}
      />,
    );
    const select = screen.getByRole("button", { name: "Select tool" });
    expect(select).toHaveAttribute("title", "Select tool (V)");
    expect(select).toHaveAttribute("aria-keyshortcuts", "V");
    const blade = screen.getByRole("button", { name: "Blade tool" });
    expect(blade).toHaveAttribute(
      "title",
      "Blade tool (C): split at click or playhead",
    );
    expect(blade).toHaveAttribute("aria-keyshortcuts", "C");
    const comment = screen.getByRole("button", { name: "Toggle comment mode" });
    expect(comment).toHaveAttribute(
      "title",
      "Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)",
    );
    expect(comment).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+C");
  });

  it("renders inside a group with the shared segmented classes", () => {
    render(
      <ToolModeToggleView
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
        {...actions()}
      />,
    );
    const group = screen.getByRole("group", { name: "Timeline tool" });
    expect(group.classList.contains("ui-segmented")).toBe(true);
    expect(group.classList.contains("tool-mode-toggle")).toBe(true);
  });

  it("keeps Select and disabled Blade visible for a viewer", () => {
    render(
      <ToolModeToggleView
        bladeReason="Blade requires permission to suggest edits"
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
        {...actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "Select tool" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Blade tool" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Blade tool" })).toHaveAttribute(
      "title",
      "Blade requires permission to suggest edits",
    );
    expect(
      screen.getByRole("button", { name: "Toggle comment mode" }),
    ).toBeTruthy();
  });

  it("calls each callback on click", async () => {
    const user = userEvent.setup();
    const cbs = actions();
    render(
      <ToolModeToggleView
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
        {...cbs}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Select tool" }));
    await user.click(screen.getByRole("button", { name: "Blade tool" }));
    await user.click(
      screen.getByRole("button", { name: "Toggle comment mode" }),
    );
    expect(cbs.onSelect).toHaveBeenCalledTimes(1);
    expect(cbs.onBlade).toHaveBeenCalledTimes(1);
    expect(cbs.onToggleComment).toHaveBeenCalledTimes(1);
  });
});
