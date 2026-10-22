import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BottomSheet } from "./BottomSheet";
import { Dialog } from "./Dialog";
import { registerFocusHold } from "./focusHold";
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
  const layers: ReturnType<typeof openOverlay>[] = [];
  const holds: (() => void)[] = [];
  afterEach(() => {
    const chrome = document.querySelector<HTMLElement>("[data-daw-app-chrome]");
    if (chrome) {
      chrome.inert = false;
    }
    for (const layer of layers.splice(0)) closeOverlay(layer);
    for (const release of holds.splice(0)) release();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("yields sheet entry to a registered focus hold but keeps modal priority", () => {
    holds.push(
      registerFocusHold(
        (doc) => doc.activeElement?.hasAttribute("data-held") ?? false,
      ),
    );
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
          <button type="button" data-held>
            Undo entry
          </button>
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
  });

  it("does not take sheet entry focus behind a modal that opened first", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    layers.push(openOverlay(true));
    function Sheet() {
      const panelRef = useRef<HTMLDivElement>(null);
      useDialogModal({ open: true, onClose: vi.fn(), panelRef, mode: "sheet" });
      return (
        <div ref={panelRef}>
          <button type="button">Close sheet</button>
        </div>
      );
    }
    render(<Sheet />);
    act(() => frames.shift()?.(0));
    expect(
      screen.getByRole("button", { name: "Close sheet" }),
    ).not.toHaveFocus();
  });

  it.each(["replaced", "disconnected", "covered"])(
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
      render(<Entry />);
      if (obsolete === "replaced") {
        panelRef.current = document.createElement("div");
        panelRef.current.append(document.createElement("button"));
        document.body.append(panelRef.current);
      }
      if (obsolete === "disconnected") original.remove();
      if (obsolete === "covered") layers.push(openOverlay(true));
      const focus = vi.spyOn(close, "focus");
      act(() => frame?.(0));
      expect(focus).not.toHaveBeenCalled();
      expect(panelRef.current.querySelector("button")).not.toHaveFocus();
    },
  );

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

  it("returns focus to the clicked opener when the click left focus on <body>", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PressedControlHost />
        <OpenFromOutside />
      </>,
    );
    expect(document.activeElement).toBe(document.body);
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

describe("useDialogModal fallback focus", () => {
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

  it("leaves focus on the control the user moved to when a popover's anchor is gone", async () => {
    let api: { closePopover: () => void; dropAnchor: () => void } = {
      closePopover: () => undefined,
      dropAnchor: () => undefined,
    };
    function Popover({
      anchorRef,
      onClose,
    }: {
      anchorRef: React.RefObject<HTMLElement | null>;
      onClose: () => void;
    }) {
      const panelRef = useRef<HTMLDivElement>(null);
      useDialogModal({
        open: true,
        onClose,
        panelRef,
        mode: "sheet",
        returnFocusRef: anchorRef,
      });
      return (
        <div ref={panelRef} role="dialog" aria-label="Join">
          <button type="button">Fade</button>
        </div>
      );
    }
    function App() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      const [popover, setPopover] = useState(true);
      const [anchor, setAnchor] = useState(true);
      api = {
        closePopover: () => setPopover(false),
        dropAnchor: () => setAnchor(false),
      };
      return (
        <>
          <button type="button">Timeline control</button>
          {anchor ? (
            <button type="button" ref={anchorRef}>
              Join glyph
            </button>
          ) : null}
          <BottomSheet
            open
            onClose={() => undefined}
            backgroundPolicy="interactive"
            title="Inspector"
          >
            <button type="button">Inspector field</button>
          </BottomSheet>
          {popover ? (
            <Popover anchorRef={anchorRef} onClose={() => setPopover(false)} />
          ) : null}
        </>
      );
    }
    render(<App />);
    await settle();
    act(() => api.dropAnchor());
    act(() => screen.getByRole("button", { name: "Timeline control" }).focus());
    act(() => api.closePopover());
    await settle();
    expect(document.activeElement?.textContent).toBe("Timeline control");
  });

  it("returns focus to a closing sheet's opener, not the sheet beneath, when its confirm closes with it", async () => {
    let api: { setB: (v: boolean) => void; setConfirm: (v: boolean) => void } =
      { setB: () => undefined, setConfirm: () => undefined };
    function App() {
      const [b, setB] = useState(false);
      const [confirm, setConfirm] = useState(false);
      api = { setB, setConfirm };
      return (
        <>
          <button type="button" onClick={() => setB(true)}>
            Open B
          </button>
          <BottomSheet
            open
            onClose={() => undefined}
            backgroundPolicy="interactive"
            title="A"
          >
            <button type="button">A field</button>
          </BottomSheet>
          {b ? (
            <BottomSheet
              open
              onClose={() => setB(false)}
              backgroundPolicy="interactive"
              title="B"
            >
              <button type="button" onClick={() => setConfirm(true)}>
                Delete
              </button>
              <Dialog
                open={confirm}
                onClose={() => setConfirm(false)}
                title="Sure?"
              >
                <p>Really?</p>
              </Dialog>
            </BottomSheet>
          ) : null}
        </>
      );
    }
    render(<App />);
    await settle();
    act(() => screen.getByRole("button", { name: "Open B" }).focus());
    act(() => api.setB(true));
    await settle();
    act(() => screen.getByRole("button", { name: "Delete" }).focus());
    act(() => api.setConfirm(true));
    await settle();
    act(() => api.setB(false));
    await settle();
    expect(document.activeElement?.textContent).toBe("Open B");
  });
});

describe("useDialogModal Escape across a remount", () => {
  it("closes only the confirm when the sheet beneath it remounted after the confirm opened", async () => {
    // A browser commits a store update in the microtask after the listener that
    // made it, before the next listener of the same key event; jsdom runs them
    // in one task, so the confirm's close commits inside its handler instead.
    let confirmOpen = false;
    const listeners = new Set<() => void>();
    const setConfirmOpen = (open: boolean) => {
      confirmOpen = open;
      for (const listener of listeners) listener();
    };
    let api = {
      remount: () => undefined as void,
      confirm: setConfirmOpen,
    };
    const sheetCloses = vi.fn();
    function App() {
      const [generation, setGeneration] = useState(0);
      const confirm = useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => confirmOpen,
      );
      api = {
        remount: () => setGeneration((n) => n + 1),
        confirm: setConfirmOpen,
      };
      return (
        <>
          <BottomSheet
            key={generation}
            open
            onClose={sheetCloses}
            backgroundPolicy="interactive"
            title="Inspector"
          >
            <button type="button">Remove track</button>
          </BottomSheet>
          <Dialog
            open={confirm}
            onClose={() => flushSync(() => setConfirmOpen(false))}
            title="Remove?"
          >
            <p>Sure?</p>
          </Dialog>
        </>
      );
    }
    const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
    render(<App />);
    await settle();
    act(() => api.confirm(true));
    await settle();
    act(() => api.remount());
    await settle();

    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 50));
    env.IS_REACT_ACT_ENVIRONMENT = true;

    expect(screen.queryByRole("dialog", { name: "Remove?" })).toBeNull();
    expect(sheetCloses).not.toHaveBeenCalled();
  });

  it("closes the later non-modal popover when the sheet beneath it remounts", async () => {
    const sheetCloses = vi.fn();
    const popoverCloses = vi.fn();
    let api = { remount: () => undefined as void };
    function Peek({ onClose }: { onClose: () => void }) {
      const panelRef = useRef<HTMLDivElement>(null);
      useDialogModal({
        open: true,
        onClose,
        panelRef,
        mode: "sheet",
      });
      return (
        <div ref={panelRef} role="dialog" aria-label="Join">
          <button type="button">Fade</button>
        </div>
      );
    }
    function App() {
      const [generation, setGeneration] = useState(0);
      api = { remount: () => setGeneration((n) => n + 1) };
      return (
        <>
          <BottomSheet
            key={generation}
            open
            onClose={sheetCloses}
            backgroundPolicy="interactive"
            title="Inspector"
          >
            <button type="button">Inspector field</button>
          </BottomSheet>
          <Peek onClose={popoverCloses} />
        </>
      );
    }
    const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
    const { container } = render(<App />);
    await settle();
    act(() => api.remount());
    await settle();
    await expectNoA11yViolations(container);

    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 50));
    env.IS_REACT_ACT_ENVIRONMENT = true;

    expect(popoverCloses).toHaveBeenCalledOnce();
    expect(sheetCloses).not.toHaveBeenCalled();
  });
});

describe("useDialogModal unfocusable return target", () => {
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

  it.each(["disabled", "inert", "hidden"] as const)(
    "falls back off a %s return target instead of leaving focus on body",
    async (invalid) => {
      let api = { closePeek: () => undefined as void };
      function Peek({
        onClose,
        returnFocusRef,
      }: {
        onClose: () => void;
        returnFocusRef: RefObject<HTMLElement | null>;
      }) {
        const panelRef = useRef<HTMLDivElement>(null);
        useDialogModal({
          open: true,
          onClose,
          panelRef,
          mode: "sheet",
          returnFocusRef,
        });
        return (
          <div ref={panelRef} role="dialog" aria-label="Join">
            <button type="button">Fade</button>
          </div>
        );
      }
      function App() {
        const returnRef = useRef<HTMLButtonElement>(null);
        const [peek, setPeek] = useState(true);
        api = { closePeek: () => setPeek(false) };
        return (
          <>
            <button type="button" ref={returnRef}>
              Join glyph
            </button>
            <BottomSheet
              open
              onClose={() => undefined}
              backgroundPolicy="interactive"
              title="Inspector"
            >
              <button type="button">Inspector field</button>
            </BottomSheet>
            {peek ? (
              <Peek onClose={() => setPeek(false)} returnFocusRef={returnRef} />
            ) : null}
          </>
        );
      }
      render(<App />);
      await settle();
      const badge = screen.getByRole("button", {
        name: "Join glyph",
      }) as HTMLButtonElement;
      if (invalid === "disabled") badge.disabled = true;
      if (invalid === "inert") badge.setAttribute("inert", "");
      if (invalid === "hidden") badge.hidden = true;
      act(() => screen.getByRole("button", { name: "Fade" }).focus());
      act(() => api.closePeek());
      await settle();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).not.toBe(badge);
    },
  );
});

describe("useDialogModal new sheet Close vs deferred entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes Close after deferred in-panel first entry", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    function DeferredEntry() {
      const addRef = useRef<HTMLButtonElement>(null);
      useEffect(() => {
        const previous = document.activeElement;
        const id = requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active !== previous && active !== document.body) return;
          addRef.current?.focus();
        });
        return () => cancelAnimationFrame(id);
      }, []);
      return (
        <button ref={addRef} type="button">
          Add point
        </button>
      );
    }
    function Sheet() {
      const panelRef = useRef<HTMLDivElement>(null);
      const closeRef = useRef<HTMLButtonElement>(null);
      useDialogModal({
        open: true,
        onClose: vi.fn(),
        panelRef,
        initialFocusRef: closeRef,
        mode: "sheet",
      });
      return (
        <div ref={panelRef} role="dialog" aria-label="Inspector">
          <button ref={closeRef} type="button">
            Close ordinary sheet
          </button>
          <DeferredEntry />
        </div>
      );
    }
    render(<Sheet />);
    const pending = [...frames.values()];
    frames.clear();
    act(() => {
      for (const frame of pending) frame(0);
    });
    expect(
      screen.getByRole("button", { name: "Close ordinary sheet" }),
    ).toHaveFocus();
  });
});

describe("useDialogModal remount close restore", () => {
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

  it("keeps waiver-draft focus when a keyed inspector remounts under a docked actionbar", async () => {
    let api = { remount: () => undefined as void };
    function App() {
      const [generation, setGeneration] = useState(0);
      const hostRef = useRef<HTMLDivElement | null>(null);
      const lastFocusRef = useRef<HTMLElement | null>(null);
      if (hostRef.current == null) {
        const host = document.createElement("div");
        host.className = "pending-actionbar";
        const reason = document.createElement("textarea");
        reason.setAttribute("aria-label", "Waiver reason");
        reason.value = "Reviewed every flagged transcript word";
        host.append(reason);
        hostRef.current = host;
      }
      api = { remount: () => setGeneration((n) => n + 1) };
      useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const remember = (event: FocusEvent) => {
          if (
            event.target instanceof HTMLElement &&
            host.contains(event.target)
          ) {
            lastFocusRef.current = event.target;
          }
        };
        host.addEventListener("focusin", remember);
        return () => host.removeEventListener("focusin", remember);
      }, []);
      useLayoutEffect(() => {
        const host = hostRef.current;
        const chrome = document.querySelector<HTMLElement>(
          ".bottom-sheet-chrome",
        );
        if (!host || !chrome || host.parentElement === chrome) return;
        const active = document.activeElement;
        const focusedInHost =
          active instanceof HTMLElement && host.contains(active)
            ? active
            : null;
        const remembered =
          lastFocusRef.current && host.contains(lastFocusRef.current)
            ? lastFocusRef.current
            : null;
        chrome.append(host);
        const restore = focusedInHost ?? remembered;
        if (restore?.isConnected) restore.focus({ preventScroll: true });
      });
      useLayoutEffect(() => () => hostRef.current?.remove(), []);
      return (
        <>
          <button type="button">Timeline control</button>
          <BottomSheet
            key={generation}
            open
            onClose={() => undefined}
            backgroundPolicy="interactive"
            title="Inspector"
          >
            <button type="button">Inspector field</button>
          </BottomSheet>
        </>
      );
    }
    render(<App />);
    await settle();
    const reason = screen.getByRole("textbox", { name: "Waiver reason" });
    act(() => reason.focus());
    act(() => api.remount());
    await settle();
    const moved = screen.getByRole("textbox", { name: "Waiver reason" });
    expect(moved).toHaveValue("Reviewed every flagged transcript word");
    expect(moved).toHaveFocus();
  });

  it("returns focus to the timeline control when a sheet remounts closed", async () => {
    let api = {
      remountClosed: () => undefined as void,
    };
    function App() {
      const [generation, setGeneration] = useState(0);
      const [open, setOpen] = useState(true);
      api = {
        remountClosed: () => {
          setGeneration((n) => n + 1);
          setOpen(false);
        },
      };
      return (
        <>
          <button type="button">Timeline control</button>
          {open ? (
            <BottomSheet
              key={generation}
              open
              onClose={() => setOpen(false)}
              backgroundPolicy="interactive"
              title="Track"
            >
              <button type="button">Mute</button>
            </BottomSheet>
          ) : null}
        </>
      );
    }
    render(<App />);
    await settle();
    act(() => screen.getByRole("button", { name: "Timeline control" }).focus());
    act(() => api.remountClosed());
    await settle();
    expect(screen.queryByRole("dialog", { name: "Track" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Timeline control" }),
    ).toHaveFocus();
  });

  it("does not leave focus on body after closing a confirm that survived rotation", async () => {
    let api = {
      rotate: () => undefined as void,
      closeConfirm: () => undefined as void,
    };
    function App() {
      const [epoch, setEpoch] = useState(0);
      const [confirming, setConfirming] = useState(true);
      api = {
        rotate: () => setEpoch((n) => n + 1),
        closeConfirm: () => setConfirming(false),
      };
      return (
        <>
          <button type="button">Timeline control</button>
          <BottomSheet
            key={epoch}
            open
            onClose={() => undefined}
            backgroundPolicy="interactive"
            title="Inspector"
          >
            <button type="button">Remove track</button>
          </BottomSheet>
          <Dialog
            open={confirming}
            onClose={() => setConfirming(false)}
            title="Remove the guest track?"
          >
            <p>Its clips go too.</p>
          </Dialog>
        </>
      );
    }
    render(<App />);
    await settle();
    act(() => api.rotate());
    await settle();
    act(() => api.closeConfirm());
    await settle();
    expect(document.activeElement).not.toBe(document.body);
    expect(
      screen.queryByRole("dialog", { name: "Remove the guest track?" }),
    ).toBeNull();
  });
});
