import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Dialog } from "./Dialog";

function NestedDialog() {
  const [open, setOpen] = useState(false);
  return (
    <main data-daw-app-chrome>
      <button type="button" onClick={() => setOpen(true)}>
        Parameters
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Parameters">
        <input aria-label="Amount" />
      </Dialog>
    </main>
  );
}

it("keeps a dialog usable outside inert application chrome", async () => {
  const user = userEvent.setup();
  const { container } = render(<NestedDialog />);
  const trigger = screen.getByRole("button", { name: "Parameters" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Parameters" });
  expect(dialog.closest("[data-daw-app-chrome]")).toBeNull();
  expect(container.querySelector<HTMLElement>("main")?.inert).toBe(true);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Close$/ })).toHaveFocus(),
  );
  await expectNoA11yViolations(dialog);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(container.querySelector<HTMLElement>("main")?.inert).toBe(false);
  expect(trigger).toHaveFocus();
});

it("pins a footer below the scrolling body and lets a caller opt out of the sheet with a reason", async () => {
  const { baseElement, rerender } = render(
    <Dialog
      open
      onClose={() => undefined}
      title="Share"
      footer={<button type="button">Create review link</button>}
    >
      <p>Body</p>
    </Dialog>,
  );
  const dialog = screen.getByRole("dialog", { name: "Share" });
  expect(dialog).not.toHaveClass("ui-dialog-root--centered");
  const panel = dialog.querySelector(".command-palette-panel") as HTMLElement;
  expect([...panel.children].map((child) => child.className)).toEqual([
    "command-palette-header",
    "command-palette-body",
    "command-palette-footer",
  ]);
  expect(panel.querySelector(".command-palette-footer")).toContainElement(
    screen.getByRole("button", { name: "Create review link" }),
  );
  await expectNoA11yViolations(baseElement);

  rerender(
    <Dialog
      open
      onClose={() => undefined}
      title="Share"
      centeredReason="Holds a waveform the person must see around it"
    >
      <p>Body</p>
    </Dialog>,
  );
  expect(screen.getByRole("dialog", { name: "Share" })).toHaveClass(
    "ui-dialog-root--centered",
  );
  expect(document.querySelector(".command-palette-footer")).toBeNull();
});

afterEach(() => vi.restoreAllMocks());

it("focuses only the innermost of two dialogs opened together", () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  render(
    <>
      <Dialog open onClose={() => undefined} title="Outer">
        <p>Outer body</p>
      </Dialog>
      <Dialog open onClose={() => undefined} title="Inner">
        <p>Inner body</p>
      </Dialog>
    </>,
  );
  const inner = screen.getByRole("dialog", { name: "Inner" });
  const framesOuterLast = frames.reverse();
  act(() => {
    for (const frame of framesOuterLast) frame(0);
  });
  expect(within(inner).getByRole("button", { name: /^Close$/ })).toHaveFocus();
});

it("keeps an anchored dialog non-modal, beside its anchor, closing on an outside press", async () => {
  const onClose = vi.fn();
  function Anchored() {
    const anchorRef = useRef<HTMLButtonElement>(null);
    return (
      <main data-daw-app-chrome>
        <button ref={anchorRef} type="button">
          Join badge
        </button>
        <button type="button">Elsewhere</button>
        <Dialog
          open
          onClose={onClose}
          title="Fade join at 0:05.0"
          panelId="join-panel"
          anchor={{ ref: anchorRef, reason: "The seam stays in view." }}
        >
          <p>Body</p>
        </Dialog>
      </main>
    );
  }
  const { container } = render(<Anchored />);
  const dialog = screen.getByRole("dialog", { name: "Fade join at 0:05.0" });
  expect(dialog).toHaveAttribute("aria-modal", "false");
  expect(dialog).toHaveAttribute("id", "join-panel");
  expect(dialog.style.left).toMatch(/px$/);
  expect(document.querySelector(".command-palette-scrim")).toBeNull();
  expect(container.querySelector<HTMLElement>("main")?.inert).not.toBe(true);
  await expectNoA11yViolations(dialog);

  fireEvent.pointerDown(dialog);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Join badge" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
