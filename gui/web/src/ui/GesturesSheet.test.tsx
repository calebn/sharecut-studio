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

  it("describes two-finger Undo as an optional Sharecut shortcut", () => {
    render(
      <GesturesSheet
        open
        onClose={() => undefined}
        onShowKeyboardShortcuts={() => undefined}
      />,
    );
    const undoGesture = screen.getByText("Two-finger tap").parentElement;
    expect(undoGesture).toHaveTextContent(
      "Undo: Undo the last action. Optional Sharecut shortcut.",
    );
    expect(screen.queryByText(/iOS system convention/i)).toBeNull();
  });

  it("does not render when closed", () => {
    const { baseElement: container } = render(
      <GesturesSheet
        open={false}
        onClose={() => {}}
        onShowKeyboardShortcuts={() => {}}
      />,
    );
    expect(container.textContent).not.toContain("Two-finger tap");
  });

  it("opens commands and shortcuts through the supplied callback", () => {
    const onShowKeyboardShortcuts = vi.fn();
    render(
      <GesturesSheet
        open
        onClose={() => undefined}
        onShowKeyboardShortcuts={onShowKeyboardShortcuts}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Commands and shortcuts" }),
    );
    expect(onShowKeyboardShortcuts).toHaveBeenCalledOnce();
  });

  it("is axe-clean", async () => {
    const { baseElement: container } = render(
      <GesturesSheet
        open={true}
        onClose={() => {}}
        onShowKeyboardShortcuts={() => {}}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
