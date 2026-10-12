import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOverlay, openOverlay } from "./modalGate";
import { usePressedControl } from "./pressedControl";
import { useDialogModal } from "./useDialogModal";

function PressedControlHost() {
  usePressedControl();
  return null;
}

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

function ReturnFocusHarness({ explicit = true }: { explicit?: boolean }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLButtonElement>(null);
  useDialogModal({
    open,
    onClose: () => setOpen(false),
    panelRef,
    mode: "sheet",
    returnFocusRef: explicit ? returnRef : undefined,
  });
  return (
    <>
      <button ref={returnRef} type="button">
        Return here
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Navigate
      </button>
      {open ? (
        <div ref={panelRef} role="dialog" aria-label="Sheet">
          <button type="button" onClick={() => setOpen(false)}>
            Close sheet
          </button>
        </div>
      ) : null}
    </>
  );
}

describe("useDialogModal", () => {
  it("preserves a focused feedback action at sheet entry but keeps modal priority", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    function Entry({ mode }: { mode: "sheet" | "modal" }) {
      const panelRef = useRef<HTMLDivElement>(null);
      useDialogModal({ open: true, onClose: vi.fn(), panelRef, mode });
      return (
        <div ref={panelRef}>
          <button type="button">Close entry</button>
          <div className="ui-toast-region--app">
            <button type="button" data-feedback-focus>
              Undo entry
            </button>
          </div>
        </div>
      );
    }
    const { unmount } = render(<Entry mode="sheet" />);
    act(() => screen.getByRole("button", { name: "Undo entry" }).focus());
    act(() => frames.shift()?.(0));
    expect(screen.getByRole("button", { name: "Undo entry" })).toHaveFocus();
    unmount();
    render(<Entry mode="modal" />);
    act(() => screen.getByRole("button", { name: "Undo entry" }).focus());
    act(() => frames.shift()?.(0));
    expect(screen.getByRole("button", { name: "Close entry" })).toHaveFocus();
    vi.restoreAllMocks();
  });

  it.each(["replaced", "disconnected", "inert", "covered"])(
    "rejects a %s sheet before its initial frame",
    (obsolete) => {
      let frame: FrameRequestCallback | undefined;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frame = callback;
          return 1;
        },
      );
      const panelRef = { current: document.createElement("div") };
      const close = document.createElement("button");
      panelRef.current.append(close);
      document.body.append(panelRef.current);
      function Entry() {
        useDialogModal({
          open: true,
          onClose: vi.fn(),
          panelRef,
          mode: "sheet",
        });
        return null;
      }
      const original = panelRef.current;
      const { unmount } = render(<Entry />);
      if (obsolete === "replaced") {
        panelRef.current = document.createElement("div");
        panelRef.current.append(document.createElement("button"));
        document.body.append(panelRef.current);
      }
      if (obsolete === "disconnected") original.remove();
      if (obsolete === "inert") original.setAttribute("inert", "");
      const overlay = obsolete === "covered" ? openOverlay(true) : null;
      const focus = vi.spyOn(close, "focus");
      act(() => frame?.(0));
      expect(focus).not.toHaveBeenCalled();
      expect(panelRef.current.querySelector("button")).not.toHaveFocus();
      if (overlay) closeOverlay(overlay);
      unmount();
      original.remove();
      panelRef.current.remove();
      vi.restoreAllMocks();
    },
  );

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

  it("returns focus to the clicked opener when the click left focus on <body> (Safari)", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PressedControlHost />
        <OpenFromOutside />
      </>,
    );
    expect(document.activeElement).toBe(document.body);
    // WebKit does not focus a clicked button: the click lands, focus stays put.
    fireEvent.click(screen.getByTestId("open-modal"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("open-modal")).toHaveFocus();
  });

  it("returns focus to the clicked opener when WebKit focused its container instead", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PressedControlHost />
        <section tabIndex={-1} data-testid="container" aria-label="Sheet body">
          <OpenFromOutside />
        </section>
      </>,
    );
    screen.getByTestId("container").focus();
    fireEvent.click(screen.getByTestId("open-modal"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("open-modal")).toHaveFocus();
  });

  it("returns focus to the focused control, not an older click, when a key opened it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PressedControlHost />
        <button type="button" data-testid="elsewhere">
          Elsewhere
        </button>
        <OpenFromOutside />
      </>,
    );
    await user.click(screen.getByTestId("elsewhere"));
    const opener = screen.getByTestId("open-modal");
    opener.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("returns focus to returnFocusRef instead of the opener", async () => {
    const user = userEvent.setup();
    render(<ReturnFocusHarness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Return here" })).toHaveFocus();
  });

  it("keeps the explicit return target authoritative after outside navigation", async () => {
    const user = userEvent.setup();
    render(<ReturnFocusHarness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByRole("button", { name: "Return here" })).toHaveFocus();
  });

  it("preserves outside navigation focus for a sheet with default restoration", async () => {
    const user = userEvent.setup();
    render(<ReturnFocusHarness explicit={false} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByRole("button", { name: "Navigate" })).toHaveFocus();
  });

  it("restores the opener after the focused sheet control is removed", async () => {
    const user = userEvent.setup();
    render(<ReturnFocusHarness explicit={false} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Close sheet" }));
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
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

/** A peek sheet with a modal confirm opened over it, like Remove track over the Inspector. */
function SheetWithConfirm() {
  const [sheetOpen, setSheetOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useDialogModal({
    open: sheetOpen,
    onClose: () => setSheetOpen(false),
    panelRef: sheetRef,
    mode: "sheet",
  });
  useDialogModal({
    open: confirmOpen,
    onClose: () => setConfirmOpen(false),
    panelRef: confirmRef,
    initialFocusRef: keepRef,
  });
  return (
    <>
      <div data-daw-app-chrome>
        {sheetOpen ? (
          <div ref={sheetRef} role="dialog" aria-label="Inspector">
            <button type="button" onClick={() => setConfirmOpen(true)}>
              Remove track
            </button>
          </div>
        ) : null}
      </div>
      {confirmOpen ? (
        <div role="dialog" aria-modal="true" aria-label="Remove track?">
          <div ref={confirmRef}>
            <button ref={keepRef} type="button">
              Keep track
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

describe("useDialogModal stacking", () => {
  it("Escape closes only the confirm over a sheet, and focus returns to its opener", async () => {
    const user = userEvent.setup();
    render(<SheetWithConfirm />);
    const remove = screen.getByRole("button", { name: "Remove track" });
    await user.click(remove);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Keep track" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Remove track?" })).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Inspector" }),
    ).toBeInTheDocument();
    expect(remove).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  });
});
