import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useRef, useState } from "react";
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

it("pins a footer below the scrolling body", async () => {
  const { baseElement } = render(
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
});

it("fullScreen draws no Close, hides the title and scrim from the tab order, and takes its controls from headerEnd", () => {
  const done = createRef<HTMLButtonElement>();
  render(
    <Dialog
      open
      fullScreen
      onClose={() => undefined}
      title="Inspector"
      initialFocusRef={done}
      headerStart={<span>Maya</span>}
      headerEnd={
        <button ref={done} type="button">
          Done
        </button>
      }
    >
      <p>Body</p>
    </Dialog>,
  );
  const dialog = screen.getByRole("dialog", { name: "Inspector" });
  expect(within(dialog).queryByRole("button", { name: /^Close/ })).toBeNull();
  const scrim = dialog.querySelector(".command-palette-scrim");
  expect(scrim).toHaveAttribute("aria-hidden", "true");
  expect(scrim).toHaveAttribute("tabindex", "-1");
  expect(
    within(dialog).getByRole("heading", { name: "Inspector" }),
  ).toHaveClass("sr-only");
  expect(dialog.querySelector(".command-palette-header-end")).toContainElement(
    within(dialog).getByRole("button", { name: "Done" }),
  );
});

afterEach(() => vi.restoreAllMocks());

it("uses the latest close callback and disabled state while remaining open", () => {
  const first = vi.fn();
  const next = vi.fn();
  const view = render(
    <Dialog open onClose={first} title="Track">
      <p>Body</p>
    </Dialog>,
  );
  view.rerender(
    <Dialog open onClose={next} closeDisabled title="Track">
      <p>Body</p>
    </Dialog>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(first).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  view.rerender(
    <Dialog open onClose={next} title="Track">
      <p>Body</p>
    </Dialog>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(next).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
});

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
          Join glyph
        </button>
        <button type="button">Elsewhere</button>
        <Dialog
          open
          onClose={onClose}
          title="Fade join at 0:05.0"
          panelId="join-panel"
          anchor={{
            reason: "test anchor: stays beside the control it is about",
            ref: anchorRef,
          }}
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
  fireEvent.pointerDown(screen.getByRole("button", { name: "Join glyph" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("restores an anchored dialog's anchor by default after an outside press", async () => {
  function Anchored() {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(true);
    return (
      <>
        <button ref={anchorRef} type="button">
          Anchor
        </button>
        <button type="button">Outside</button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Anchored"
          anchor={{ reason: "test anchor focus restoration", ref: anchorRef }}
        >
          <p>Body</p>
        </Dialog>
      </>
    );
  }
  render(<Anchored />);
  const anchor = screen.getByRole("button", { name: "Anchor" });
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("dialog", { name: "Anchored" })).toBeNull();
  await waitFor(() => expect(anchor).toHaveFocus());
});

it("preserves focus on an outside control for an opted-in anchored dialog", async () => {
  function Anchored() {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const avoidRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(true);
    return (
      <>
        <button ref={anchorRef} type="button">
          Anchor
        </button>
        <button ref={avoidRef} type="button">
          Avoid
        </button>
        <button type="button">Outside</button>
        <Dialog
          outsideDismissal="preserve-focus"
          open={open}
          onClose={() => setOpen(false)}
          title="Anchored"
          anchor={{
            reason: "test outside focus preservation",
            ref: anchorRef,
            avoidRef,
          }}
        >
          <p>Body</p>
        </Dialog>
      </>
    );
  }
  render(<Anchored />);
  const dialog = screen.getByRole("dialog", { name: "Anchored" });
  const anchor = screen.getByRole("button", { name: "Anchor" });
  const avoid = screen.getByRole("button", { name: "Avoid" });
  fireEvent.pointerDown(dialog);
  fireEvent.pointerDown(anchor);
  fireEvent.pointerDown(avoid);
  expect(screen.getByRole("dialog", { name: "Anchored" })).toBeInTheDocument();
  const outside = screen.getByRole("button", { name: "Outside" });
  outside.focus();
  fireEvent.pointerDown(outside);
  expect(screen.queryByRole("dialog", { name: "Anchored" })).toBeNull();
  await waitFor(() => expect(outside).toHaveFocus());
});

it("ignores preserve-focus for non-anchored dialogs", async () => {
  function Modal() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open modal
        </button>
        <button type="button">Outside</button>
        <Dialog
          outsideDismissal="preserve-focus"
          open={open}
          onClose={() => setOpen(false)}
          title="Modal"
        >
          <p>Body</p>
        </Dialog>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Modal />);
  const opener = screen.getByRole("button", { name: "Open modal" });
  await user.click(opener);
  const outside = screen.getByRole("button", { name: "Outside" });
  fireEvent.pointerDown(outside);
  expect(screen.getByRole("dialog", { name: "Modal" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close Modal" }));
  expect(screen.queryByRole("dialog", { name: "Modal" })).toBeNull();
  await waitFor(() => expect(opener).toHaveFocus());
});

it("closes an anchored dialog when a modal opens over it", () => {
  function Both({ modal }: { modal: boolean }) {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [anchoredOpen, setAnchoredOpen] = useState(true);
    return (
      <main data-daw-app-chrome>
        <button ref={anchorRef} type="button">
          Join glyph
        </button>
        <Dialog
          open={anchoredOpen}
          onClose={() => setAnchoredOpen(false)}
          title="Fade join"
          anchor={{
            reason: "test anchor: stays beside the control it is about",
            ref: anchorRef,
          }}
        >
          <p>Body</p>
        </Dialog>
        <Dialog open={modal} onClose={() => undefined} title="Palette">
          <p>Commands</p>
        </Dialog>
      </main>
    );
  }
  const { rerender } = render(<Both modal={false} />);
  expect(screen.getByRole("dialog", { name: "Fade join" })).toBeInTheDocument();
  rerender(<Both modal />);
  expect(screen.queryByRole("dialog", { name: "Fade join" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Palette" })).toBeInTheDocument();
});

it("lets Tab reach the inner dialog's buttons when two modals are stacked", async () => {
  const user = userEvent.setup();
  render(
    <>
      <Dialog open onClose={() => undefined} title="Outer">
        <button type="button">Outer action</button>
      </Dialog>
      <Dialog open onClose={() => undefined} title="Inner">
        <button type="button">Inner action</button>
      </Dialog>
    </>,
  );
  const inner = screen.getByRole("dialog", { name: "Inner" });
  const innerAction = within(inner).getByRole("button", {
    name: "Inner action",
  });
  const outer = screen.getByRole("dialog", { name: "Outer" });
  const outerFocus = vi.fn();
  outer.addEventListener("focusin", outerFocus);
  innerAction.focus();
  await user.tab();
  await user.tab();
  expect(inner.contains(document.activeElement)).toBe(true);
  expect(outerFocus).not.toHaveBeenCalled();
});
