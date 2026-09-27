import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { GesturesSheet } from "./GesturesSheet";

describe("GesturesSheet", () => {
  it("renders gesture list when open", () => {
    render(
      <GesturesSheet
        open={true}
        onClose={() => {}}
        onShowKeyboardShortcuts={() => {}}
      />,
    );
    expect(screen.getByText("Two-finger tap")).toBeInTheDocument();
    expect(screen.getByText("Long-press")).toBeInTheDocument();
    expect(screen.getByText("Pinch")).toBeInTheDocument();
  });

  it("lists only shipped gestures", () => {
    render(
      <GesturesSheet
        open={true}
        onClose={() => {}}
        onShowKeyboardShortcuts={() => {}}
      />,
    );
    expect(screen.queryByText("Soon")).not.toBeInTheDocument();
    expect(screen.getByText("Double-tap word")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    const { container } = render(
      <GesturesSheet
        open={false}
        onClose={() => {}}
        onShowKeyboardShortcuts={() => {}}
      />,
    );
    expect(container.textContent).not.toContain("Two-finger tap");
  });

  it("opens keyboard shortcuts through the supplied callback", () => {
    const onShowKeyboardShortcuts = vi.fn();
    render(
      <GesturesSheet
        open
        onClose={() => undefined}
        onShowKeyboardShortcuts={onShowKeyboardShortcuts}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(onShowKeyboardShortcuts).toHaveBeenCalledOnce();
  });

  it("is axe-clean", async () => {
    const { container } = render(
      <GesturesSheet
        open={true}
        onClose={() => {}}
        onShowKeyboardShortcuts={() => {}}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
