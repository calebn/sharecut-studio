import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BottomSheet } from "./BottomSheet";

describe("BottomSheet", () => {
  it("opens from its trigger, toggles controlled sizing, and restores focus on close and Escape", async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    function ControlledSheet() {
      const [open, setOpen] = useState(false);
      const [expanded, setExpanded] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open inspector
          </button>
          <BottomSheet
            open={open}
            onClose={() => setOpen(false)}
            backgroundPolicy="interactive"
            title="Inspector"
            expanded={expanded}
            onExpandedChange={(next) => {
              onExpandedChange(next);
              setExpanded(next);
            }}
          >
            <p>Inspector details</p>
          </BottomSheet>
        </>
      );
    }

    render(<ControlledSheet />);
    const trigger = screen.getByRole("button", { name: "Open inspector" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Inspector" });
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(dialog).toHaveClass("bottom-sheet--half");
    expect(dialog.querySelector(".bottom-sheet-grab")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
    expect(dialog).toHaveClass("bottom-sheet--full");
    await expectNoA11yViolations(dialog);
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    expect(dialog).toHaveClass("bottom-sheet--half");
    await expectNoA11yViolations(dialog);

    await user.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <BottomSheet
        open={false}
        onClose={() => undefined}
        backgroundPolicy="interactive"
        title="Details"
      >
        <p>Body</p>
      </BottomSheet>,
    );
    expect(container.querySelector(".bottom-sheet")).toBeNull();
    expect(document.querySelector(".bottom-sheet")).toBeNull();
  });

  it("shows dialog with close and is axe-clean", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="interactive"
        title="Details"
      >
        <p>Body content</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog).toBeTruthy();
    await expectNoA11yViolations(dialog);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on Escape", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="interactive"
        title="Details"
      >
        <p>Body</p>
      </BottomSheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("lets the canvas receive input with an interactive background", async () => {
    const onClose = vi.fn();
    const onCanvasClick = vi.fn();
    render(
      <>
        <button type="button" onClick={onCanvasClick}>
          Timeline canvas
        </button>
        <BottomSheet
          open
          onClose={onClose}
          backgroundPolicy="interactive"
          title="Inspector"
        >
          <p>Inspector body</p>
        </BottomSheet>
      </>,
    );
    const scrim = document.querySelector(
      ".bottom-sheet-scrim--interactive",
    ) as HTMLElement;
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    expect(scrim.classList).toContain("bottom-sheet-scrim--interactive");
    await userEvent.click(
      screen.getByRole("button", { name: "Timeline canvas" }),
    );
    expect(onCanvasClick).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await expectNoA11yViolations(
      screen.getByRole("dialog", { name: "Inspector" }),
    );
  });

  it("keeps the dismiss scrim interactive for confirmations", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="dismiss"
        title="Confirm blade cut"
      >
        <p>Confirm this cut?</p>
      </BottomSheet>,
    );
    await expectNoA11yViolations(
      screen.getByRole("dialog", { name: "Confirm blade cut" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps fixed sheets closable without a resize action or drag cue", async () => {
    render(
      <BottomSheet
        open
        onClose={() => undefined}
        backgroundPolicy="dismiss"
        title="Fixed confirmation"
      >
        <p>Confirm this action?</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Fixed confirmation" });
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(dialog.querySelector(".bottom-sheet-grab")).toBeNull();
    await expectNoA11yViolations(dialog);
  });
});
