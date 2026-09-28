import { cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDialogViaLauncher } from "./openDialog";

afterEach(() => {
  cleanup();
});

describe("openDialogViaLauncher", () => {
  it("returns the already-open dialog without clicking the launcher", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <>
        <button type="button" onClick={onClick}>
          Open x
        </button>
        <div role="dialog" aria-label="X" />
      </>,
    );

    const dialog = await openDialogViaLauncher(container, "Open x", "X");

    expect(dialog).toBe(screen.getByRole("dialog", { name: "X" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("clicks the launcher to open a closed dialog, then returns it", async () => {
    function ClosedDialog() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open x
          </button>
          {open && <div role="dialog" aria-label="X" />}
        </>
      );
    }
    const { container } = render(<ClosedDialog />);

    const dialog = await openDialogViaLauncher(container, "Open x", "X");

    expect(dialog).toBe(screen.getByRole("dialog", { name: "X" }));
  });

  it("clicks the launcher when a different dialog is already open", async () => {
    function OtherDialogOpen() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <div role="dialog" aria-label="Other" />
          <button type="button" onClick={() => setOpen(true)}>
            Open x
          </button>
          {open && <div role="dialog" aria-label="X" />}
        </>
      );
    }
    const { container } = render(<OtherDialogOpen />);

    const dialog = await openDialogViaLauncher(container, "Open x", "X");

    expect(dialog).toBe(screen.getByRole("dialog", { name: "X" }));
  });
});
