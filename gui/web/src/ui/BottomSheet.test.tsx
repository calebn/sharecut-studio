import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BottomSheet } from "./BottomSheet";

describe("BottomSheet", () => {
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
});
