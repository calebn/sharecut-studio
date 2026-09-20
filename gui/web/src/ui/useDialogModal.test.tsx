import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useDialogModal } from "./useDialogModal";

function Fixture({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDialogModal({
    open,
    onClose: () => setOpen(false),
    panelRef,
    initialFocusRef: closeRef,
  });

  return (
    <div>
      <div data-daw-app-chrome>
        <button type="button" data-testid="outside">
          Outside
        </button>
      </div>
      {open ? (
        <div role="dialog" aria-modal="true" aria-label="Test dialog">
          <button type="button" aria-label="Scrim" />
          <div ref={panelRef}>
            <button ref={closeRef} type="button">
              Close
            </button>
            <button type="button">Next</button>
            <button type="button">Last</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

describe("useDialogModal", () => {
  afterEach(() => {
    const chrome = document.querySelector<HTMLElement>("[data-daw-app-chrome]");
    if (chrome) {
      chrome.inert = false;
    }
  });

  it("focuses initial control and sets inert on chrome", async () => {
    render(<Fixture />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    expect(
      document.querySelector<HTMLElement>("[data-daw-app-chrome]")?.inert,
    ).toBe(true);
  });

  it("cycles Tab within the panel", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.tab();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button" data-testid="opener">
          Opener
        </button>
        <OpenFromOutside />
      </div>,
    );
    screen.getByTestId("opener").focus();
    await user.click(screen.getByTestId("open-modal"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // Restore the control that opened the dialog (the click target).
    expect(screen.getByTestId("open-modal")).toHaveFocus();
    expect(
      document.querySelector<HTMLElement>("[data-daw-app-chrome]")?.inert,
    ).toBe(false);
  });
});

function OpenFromOutside() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDialogModal({
    open,
    onClose: () => setOpen(false),
    panelRef,
    initialFocusRef: closeRef,
  });

  return (
    <>
      <div data-daw-app-chrome>
        <span />
      </div>
      <button
        type="button"
        data-testid="open-modal"
        onClick={() => setOpen(true)}
      >
        Open
      </button>
      {open ? (
        <div role="dialog" aria-label="Restore dialog">
          <div ref={panelRef}>
            <button ref={closeRef} type="button">
              Close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
