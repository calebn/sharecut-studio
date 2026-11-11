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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { stubRaf } from "../test/raf";
import { BottomSheet } from "./BottomSheet";
import { Menu, MenuItem, MenuSection, MenuSeparator } from "./Menu";
import { menuOpen } from "./modalGate";
import { usePressedControl } from "./pressedControl";

function PressedControlCapture() {
  usePressedControl();
  return null;
}

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Test menu"
      trigger={(t) => (
        <button type="button" ref={t.ref} onClick={t.onClick}>
          Open
        </button>
      )}
    >
      <MenuItem onSelect={() => setOpen(false)}>One</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => setOpen(false)}>Two</MenuItem>
    </Menu>
  );
}

function MixedFocusFixture({
  empty = false,
  fallbackOnly = false,
  pointerControls = false,
}: {
  empty?: boolean;
  fallbackOnly?: boolean;
  pointerControls?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Mixed focus menu"
      trigger={(trigger) => (
        <button type="button" ref={trigger.ref} onClick={trigger.onClick}>
          Open mixed
        </button>
      )}
    >
      {empty ? null : (
        <>
          {!fallbackOnly && <MenuItem>First</MenuItem>}
          <MenuSeparator />
          <MenuSection label="More controls">
            <label>
              Filter label
              <input aria-label="Menu filter" />
            </label>
            <button type="button">Fallback control</button>
            <p>Supporting note</p>
            {pointerControls && (
              <>
                <button type="button" disabled>
                  Native disabled
                </button>
                <div tabIndex={-1} data-testid="negative-control">
                  Negative control
                </div>
                <div
                  contentEditable
                  tabIndex={-1}
                  role="textbox"
                  aria-label="Editable control"
                />
                <fieldset disabled>
                  <legend>
                    <input aria-label="Enabled legend input" />
                  </legend>
                  <input aria-label="Disabled fieldset input" />
                </fieldset>
                <details open>
                  <summary>Disclosure control</summary>
                  <p>Disclosure body</p>
                </details>
              </>
            )}
            {!fallbackOnly && <MenuItem>Last</MenuItem>}
          </MenuSection>
        </>
      )}
    </Menu>
  );
}

function SheetWithMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(true);
  return (
    <>
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        backgroundPolicy="interactive"
        title="Inspector"
      >
        <p>Sheet body</p>
      </BottomSheet>
      <Menu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        label="Transport menu"
        trigger={(t) => (
          <button type="button" ref={t.ref} onClick={t.onClick}>
            Menu
          </button>
        )}
      >
        <MenuItem onSelect={() => setMenuOpen(false)}>Item</MenuItem>
      </Menu>
      {!sheetOpen ? <span data-testid="sheet-closed" /> : null}
    </>
  );
}

describe("Menu", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty("--menu-edge-margin", "0.5rem");
    document.documentElement.style.setProperty("--menu-anchor-gap", "0.25rem");
    if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
      HTMLElement.prototype.scrollIntoView = () => undefined;
    }
  });

  it("restores focus to a clicked trigger when the browser leaves focus on body", async () => {
    render(
      <>
        <PressedControlCapture />
        <Fixture />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(document.body);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it.each([false, true])(
    "uses the trigger document for a fallback menu initially open=%s",
    (initialOpen) => {
      const proto = HTMLElement.prototype as Partial<HTMLElement>;
      const { showPopover, hidePopover } = proto;
      delete proto.showPopover;
      delete proto.hidePopover;
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const doc = frame.contentDocument!;
      let unmount: (() => void) | undefined;
      try {
        function OwnedDocumentMenu() {
          const [open, setOpen] = useState(initialOpen);
          return (
            <Menu
              open={open}
              onOpenChange={setOpen}
              label="Frame menu"
              trigger={(props) => (
                <button type="button" {...props}>
                  Frame trigger
                </button>
              )}
            >
              <MenuItem>Frame item</MenuItem>
            </Menu>
          );
        }
        ({ unmount } = render(<OwnedDocumentMenu />, {
          container: doc.body,
          baseElement: doc.body,
        }));
        if (!initialOpen)
          fireEvent.click(
            within(doc.body).getByRole("button", { name: "Frame trigger" }),
          );
        const panel = doc.querySelector('[role="menu"]');
        expect(panel?.ownerDocument).toBe(doc);
        expect(panel?.parentElement).toBe(doc.body);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
      } finally {
        unmount?.();
        frame.remove();
        proto.showPopover = showPopover;
        proto.hidePopover = hidePopover;
      }
    },
  );

  it("positions an initially open fallback panel before any animation frame", () => {
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const { showPopover, hidePopover } = proto;
    delete proto.showPopover;
    delete proto.hidePopover;
    stubRaf();
    try {
      render(
        <Menu
          open
          onOpenChange={vi.fn()}
          label="Initially open"
          trigger={(props) => (
            <button type="button" {...props}>
              Open
            </button>
          )}
        >
          <MenuItem>One</MenuItem>
        </Menu>,
      );
      const panel = screen.getByRole("menu", { name: "Initially open" });
      expect(panel.style.getPropertyValue("--menu-available-height")).toMatch(
        /rem$/,
      );
      expect(panel.style.left).toMatch(/px$/);
      expect(panel.style.top).toMatch(/px$/);
    } finally {
      vi.unstubAllGlobals();
      proto.showPopover = showPopover;
      proto.hidePopover = hidePopover;
    }
  });

  it("retains the open fallback panel across inline merged trigger registrations and retires it with the trigger", async () => {
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const { showPopover, hidePopover } = proto;
    delete proto.showPopover;
    delete proto.hidePopover;
    try {
      function BoundMenu({
        revision,
        attached,
      }: {
        revision: number;
        attached: boolean;
      }) {
        const [open, setOpen] = useState(true);
        const ownButton = useRef<HTMLButtonElement | null>(null);
        return (
          <Menu
            open={open}
            onOpenChange={setOpen}
            label="Bound menu"
            trigger={({ ref, ...props }) =>
              attached ? (
                <button
                  type="button"
                  {...props}
                  ref={(node) => {
                    ref(node);
                    ownButton.current = node;
                  }}
                >
                  Open {revision}
                </button>
              ) : null
            }
          >
            <MenuItem>One</MenuItem>
            <input aria-label="Menu draft" />
          </Menu>
        );
      }
      const { rerender } = render(<BoundMenu revision={1} attached />);
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus(),
      );
      const panel = screen.getByRole("menu", { name: "Bound menu" });
      expect(panel).toHaveAttribute("data-menu-mode", "fallback");
      const input = screen.getByRole("textbox", { name: "Menu draft" });
      await userEvent.type(input, "draft");
      rerender(<BoundMenu revision={2} attached />);
      expect(screen.getByRole("menu", { name: "Bound menu" })).toBe(panel);
      expect(screen.getByRole("textbox", { name: "Menu draft" })).toBe(input);
      expect(input).toHaveValue("draft");
      expect(input).toHaveFocus();
      rerender(<BoundMenu revision={2} attached={false} />);
      expect(screen.queryByRole("menu", { name: "Bound menu" })).toBeNull();
    } finally {
      proto.showPopover = showPopover;
      proto.hidePopover = hidePopover;
    }
  });

  it("forwards direct container focus from the second item without selection", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus(),
    );
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Two" })).toHaveFocus();
    act(() => screen.getByRole("menu").focus());
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it.each(["panel", "separator", "section label", "supporting note"])(
    "keeps the simulated blank-left close policy for %s",
    async (kind) => {
      const user = userEvent.setup();
      render(<MixedFocusFixture />);
      await user.click(screen.getByRole("button", { name: "Open mixed" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      act(() => screen.getByRole("menuitem", { name: "Last" }).focus());
      const target =
        kind === "panel"
          ? screen.getByRole("menu")
          : kind === "separator"
            ? screen.getByRole("separator")
            : screen.getByText(
                kind === "section label" ? "More controls" : "Supporting note",
              );
      await user.click(target);
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  it("retains the ordinary non-item label's simulated blank-left dismissal", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
    );
    act(() => screen.getByRole("menuitem", { name: "Last" }).focus());
    await user.click(screen.getByText("Filter label"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps a direct fallback control focused inside the menu", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Fallback control" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fallback control" }),
    ).toHaveFocus();
  });

  it("keeps a directly clicked fallback input and its typed draft", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
    );
    const input = screen.getByRole("textbox", { name: "Menu filter" });
    await user.click(input);
    await user.type(input, "draft");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("draft");
  });

  it("synthesizes the native blank-right blur before the new container default", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
    );
    act(() => screen.getByRole("menuitem", { name: "Last" }).focus());
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    fireEvent(screen.getByRole("menu"), down);
    expect(down.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["item", "input"])(
    "does not cancel a right mousedown on an actual %s",
    async (kind) => {
      const user = userEvent.setup();
      render(<MixedFocusFixture />);
      await user.click(screen.getByRole("button", { name: "Open mixed" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      act(() => screen.getByRole("menuitem", { name: "Last" }).focus());
      const down = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
      });
      fireEvent(
        kind === "item"
          ? screen.getByRole("menuitem", { name: "Last" })
          : screen.getByRole("textbox", { name: "Menu filter" }),
        down,
      );
      expect(down.defaultPrevented).toBe(false);
      expect(screen.getByRole("menu")).toBeInTheDocument();
    },
  );

  it("keeps child blur ahead of controlled blank dismissal", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    function BlurFixture() {
      const [open, setOpen] = useState(false);
      return (
        <Menu
          open={open}
          onOpenChange={(next) => {
            if (!next) events.push("close");
            setOpen(next);
          }}
          label="Blur menu"
          trigger={(trigger) => (
            <button type="button" ref={trigger.ref} onClick={trigger.onClick}>
              Open blur menu
            </button>
          )}
        >
          <MenuItem onBlur={() => events.push("blur")}>Blur item</MenuItem>
        </Menu>
      );
    }
    render(<BlurFixture />);
    await user.click(screen.getByRole("button", { name: "Open blur menu" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Blur item" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("menu"));
    expect(events).toEqual(["blur", "close"]);
  });

  it("admits direct empty-root focus without adding a sequential stop", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture empty />);
    const trigger = screen.getByRole("button", { name: "Open mixed" });
    await user.click(trigger);
    expect(trigger).toHaveFocus();
    const menu = screen.getByRole("menu");
    act(() => menu.focus());
    expect(menu).toHaveFocus();
    expect(menu.tabIndex).toBe(-1);
    expect(menu).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("forwards direct root focus to the first ordinary fallback control", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture fallbackOnly />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    const input = screen.getByRole("textbox", { name: "Menu filter" });
    await waitFor(() => expect(input).toHaveFocus());
    act(() => screen.getByRole("button", { name: "Fallback control" }).focus());
    act(() => screen.getByRole("menu").focus());
    expect(input).toHaveFocus();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("keeps a scrollable menu open when its scrollbar is pressed", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
    );
    const panel = screen.getByRole("menu");
    Object.defineProperty(panel, "clientWidth", { value: 100 });
    Object.defineProperty(panel, "clientHeight", { value: 100 });
    panel.getBoundingClientRect = () => new DOMRect(0, 0, 115, 100);
    fireEvent.mouseDown(panel, { button: 0, clientX: 110, clientY: 50 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    fireEvent.mouseDown(panel, { button: 0, clientX: 50, clientY: 50 });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not manufacture a blank-left close in an empty menu", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture empty />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    await user.click(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it.each(["negative", "editable", "summary"])(
    "preserves real pointer focus in a %s descendant",
    async (kind) => {
      const user = userEvent.setup();
      render(<MixedFocusFixture pointerControls />);
      await user.click(screen.getByRole("button", { name: "Open mixed" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      act(() => screen.getByRole("menuitem", { name: "Last" }).focus());
      expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
      const target =
        kind === "negative"
          ? screen.getByTestId("negative-control")
          : kind === "editable"
            ? screen.getByRole("textbox", { name: "Editable control" })
            : screen.getByText("Disclosure control");
      await user.click(target);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(target).toHaveFocus();
    },
  );

  it.each(["[MouseLeft]", "[MouseRight]"])(
    "preserves enabled first-legend input pointer focus for %s",
    async (keys) => {
      const user = userEvent.setup();
      render(<MixedFocusFixture pointerControls />);
      await user.click(screen.getByRole("button", { name: "Open mixed" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      act(() => screen.getByRole("menuitem", { name: "Last" }).focus());
      const input = screen.getByRole("textbox", {
        name: "Enabled legend input",
      });
      expect(input.matches(":disabled")).toBe(false);
      expect(
        screen
          .getByRole("textbox", { name: "Disabled fieldset input" })
          .matches(":disabled"),
      ).toBe(true);
      await user.pointer({ target: input, keys });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(input).toHaveFocus();
    },
  );

  it.each(["[MouseLeft]", "[MouseRight]"])(
    "preserves native-disabled dismissal for %s",
    async (keys) => {
      const user = userEvent.setup();
      render(<MixedFocusFixture pointerControls />);
      const trigger = screen.getByRole("button", { name: "Open mixed" });
      await user.click(trigger);
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      act(() => screen.getByRole("menuitem", { name: "Last" }).focus());
      await user.pointer({
        target: screen.getByRole("button", { name: "Native disabled" }),
        keys,
      });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      await waitFor(() => expect(trigger).toHaveFocus());
    },
  );

  it.each(["[MouseLeft]", "[MouseRight]"])(
    "honors canceled native-disabled pointerdown for %s",
    async (keys) => {
      const user = userEvent.setup();
      render(<MixedFocusFixture pointerControls />);
      await user.click(screen.getByRole("button", { name: "Open mixed" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      const last = screen.getByRole("menuitem", { name: "Last" });
      act(() => last.focus());
      const target = screen.getByRole("button", { name: "Native disabled" });
      const cancel = (event: Event) => event.preventDefault();
      target.addEventListener("pointerdown", cancel);
      try {
        await user.pointer({ target, keys });
        expect(screen.getByRole("menu")).toBeInTheDocument();
        expect(last).toHaveFocus();
      } finally {
        target.removeEventListener("pointerdown", cancel);
      }
    },
  );

  it("honors an actual child consumer's canceled blank mousedown", async () => {
    const user = userEvent.setup();
    render(<MixedFocusFixture />);
    await user.click(screen.getByRole("button", { name: "Open mixed" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
    );
    const last = screen.getByRole("menuitem", { name: "Last" });
    act(() => last.focus());
    const target = screen.getByText("Supporting note");
    const cancel = (event: MouseEvent) => event.preventDefault();
    target.addEventListener("mousedown", cancel);
    try {
      await user.click(target);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(last).toHaveFocus();
    } finally {
      target.removeEventListener("mousedown", cancel);
    }
  });

  it("preserves a foreign-document menu's blank pointer dismissal", async () => {
    const proto = HTMLElement.prototype;
    const show = Object.getOwnPropertyDescriptor(proto, "showPopover");
    const hide = Object.getOwnPropertyDescriptor(proto, "hidePopover");
    Reflect.deleteProperty(proto, "showPopover");
    Reflect.deleteProperty(proto, "hidePopover");
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const doc = frame.contentDocument!;
    const user = userEvent.setup({ document: doc });
    let unmount: (() => void) | undefined;
    try {
      ({ unmount } = render(<MixedFocusFixture />, {
        container: doc.body,
        baseElement: doc.body,
      }));
      const menu = within(doc.body);
      await user.click(menu.getByRole("button", { name: "Open mixed" }));
      await waitFor(() =>
        expect(menu.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      act(() => menu.getByRole("menuitem", { name: "Last" }).focus());
      expect(menu.getByRole("menuitem", { name: "Last" })).toHaveFocus();
      await user.click(menu.getByRole("menu"));
      expect(menu.queryByRole("menu")).toBeNull();
    } finally {
      unmount?.();
      frame.remove();
      if (show) Object.defineProperty(proto, "showPopover", show);
      else Reflect.deleteProperty(proto, "showPopover");
      if (hide) Object.defineProperty(proto, "hidePopover", hide);
      else Reflect.deleteProperty(proto, "hidePopover");
    }
  });

  it("opens, traps arrows among menuitems, closes on Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(menuOpen()).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    const separator = screen.getByRole("separator");
    expect(separator.tabIndex).toBe(-1);
    expect(separator).not.toHaveAccessibleName();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Two" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuOpen()).toBe(false);
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    await expectNoA11yViolations(container);
  });

  it("opens as a fixed panel on a webview without the Popover API", async () => {
    const user = userEvent.setup();
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const { showPopover, hidePopover } = proto;
    delete proto.showPopover;
    delete proto.hidePopover;
    try {
      render(<Fixture />);
      await user.click(screen.getByRole("button", { name: "Open" }));
      const panel = screen.getByRole("menu", { hidden: true });
      expect(panel).toHaveAttribute("aria-label", "Test menu");
      expect(panel).not.toHaveAttribute("popover");
      expect(panel.parentElement).toBe(document.body);
      expect(menuOpen()).toBe(true);
      await user.click(screen.getByRole("button", { name: "Open" }));
      expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
      expect(menuOpen()).toBe(false);
    } finally {
      proto.showPopover = showPopover;
      proto.hidePopover = hidePopover;
    }
  });

  it("keeps a fallback checkbox mounted and updates it on click", async () => {
    const user = userEvent.setup();
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const { showPopover, hidePopover } = proto;
    delete proto.showPopover;
    delete proto.hidePopover;
    function CheckboxMenu() {
      const [open, setOpen] = useState(false);
      const [checked, setChecked] = useState(false);
      return (
        <Menu
          open={open}
          onOpenChange={setOpen}
          label="Choices"
          trigger={(t) => (
            <button ref={t.ref} onClick={t.onClick}>
              Open
            </button>
          )}
        >
          <MenuItem>First</MenuItem>
          <label>
            <input
              type="checkbox"
              role="menuitemcheckbox"
              aria-checked={checked}
              checked={checked}
              onChange={() => setChecked((value) => !value)}
            />
            Choice
          </label>
        </Menu>
      );
    }
    try {
      render(<CheckboxMenu />);
      await user.click(screen.getByRole("button", { name: "Open" }));
      const choice = screen.getByRole("menuitemcheckbox", { name: "Choice" });
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus(),
      );
      fireEvent.mouseDown(choice, { button: 0 });
      expect(choice).toHaveFocus();
      await user.click(choice);
      expect(
        screen.getByRole("menuitemcheckbox", { name: "Choice" }),
      ).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("menu")).toBeInTheDocument();
    } finally {
      proto.showPopover = showPopover;
      proto.hidePopover = hidePopover;
    }
  });

  it("closes a fallback menu on Escape and outside press", async () => {
    const user = userEvent.setup();
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const { showPopover, hidePopover } = proto;
    delete proto.showPopover;
    delete proto.hidePopover;
    try {
      render(
        <>
          <Fixture />
          <button>Outside</button>
        </>,
      );
      await user.click(screen.getByRole("button", { name: "Open" }));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Open" }));
      await user.click(screen.getByRole("button", { name: "Outside" }));
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      proto.showPopover = showPopover;
      proto.hidePopover = hidePopover;
    }
  });

  it("uses trigger-relative Tab order for a fallback portal", async () => {
    const user = userEvent.setup();
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const { showPopover, hidePopover } = proto;
    delete proto.showPopover;
    delete proto.hidePopover;
    try {
      render(
        <>
          <button>Before</button>
          <Fixture />
          <button>After</button>
        </>,
      );
      await user.click(screen.getByRole("button", { name: "Open" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus(),
      );
      await user.tab();
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
      expect(screen.queryByRole("menu")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Open" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus(),
      );
      await user.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      proto.showPopover = showPopover;
      proto.hidePopover = hidePopover;
    }
  });

  it("closes when its already-open trigger is clicked again", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus(),
    );
    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("dismisses on Tab and preserves the next control's focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Fixture />
        <input aria-label="After menu" />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    await user.tab();
    expect(screen.getByRole("textbox", { name: "After menu" })).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuOpen()).toBe(false);
  });

  it("dismisses on Shift+Tab and preserves the trigger's focus", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("dismisses when focus moves programmatically outside", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Fixture />
        <input aria-label="Elsewhere" />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    act(() => screen.getByRole("textbox", { name: "Elsewhere" }).focus());
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{ArrowDown}{Home}{End}");
    expect(screen.getByRole("textbox", { name: "Elsewhere" })).toHaveFocus();
  });

  it("ignores navigation outside a menu whose owner has not closed it yet", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <>
        <Menu
          open
          onOpenChange={onOpenChange}
          label="Test menu"
          trigger={(props) => (
            <button type="button" {...props}>
              Open
            </button>
          )}
        >
          <MenuItem>One</MenuItem>
        </Menu>
        <input aria-label="Elsewhere" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    act(() => screen.getByRole("textbox", { name: "Elsewhere" }).focus());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await user.keyboard("{ArrowDown}{ArrowUp}{Home}{End}");
    expect(screen.getByRole("textbox", { name: "Elsewhere" })).toHaveFocus();
  });

  it("leaves focus where it moved when closed from outside", async () => {
    const menu = (open: boolean) => (
      <>
        <Menu
          open={open}
          onOpenChange={() => undefined}
          label="Test menu"
          trigger={(t) => (
            <button type="button" ref={t.ref} onClick={t.onClick}>
              Open
            </button>
          )}
        >
          <MenuItem onSelect={() => undefined}>One</MenuItem>
        </Menu>
        <input aria-label="Elsewhere" />
      </>
    );
    const { rerender } = render(menu(false));
    screen.getByRole("button", { name: "Open" }).focus();
    rerender(menu(true));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    // e.g. an exclusive sibling menu's trigger took focus, then closed us.
    screen.getByRole("textbox", { name: "Elsewhere" }).focus();
    rerender(menu(false));
    expect(screen.getByRole("textbox", { name: "Elsewhere" })).toHaveFocus();
  });

  it("renders the panel as a viewport-capped scroller", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const panel = screen.getByRole("menu", { name: "Test menu" });
    expect(panel.classList.contains("ui-menu-panel")).toBe(true);
    expect(panel.style.getPropertyValue("--menu-available-height")).toMatch(
      /rem$/,
    );
  });

  it("re-caps the panel when layout shifts the trigger while open", async () => {
    const user = userEvent.setup();
    const innerHeight = vi.spyOn(window, "innerHeight", "get");
    innerHeight.mockReturnValue(800);
    let triggerBottom = 100;
    const rect = vi
      .spyOn(HTMLButtonElement.prototype, "getBoundingClientRect")
      .mockImplementation(
        () =>
          ({
            left: 20,
            right: 60,
            top: triggerBottom - 32,
            bottom: triggerBottom,
          }) as unknown as DOMRect,
      );
    try {
      render(<Fixture />);
      await user.click(screen.getByRole("button", { name: "Open" }));
      const panel = screen.getByRole("menu", { name: "Test menu" });
      const rootPx = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const edge = 0.5 * rootPx;
      const gap = 0.25 * rootPx;
      const remFor = (bottom: number) =>
        `${(800 - edge - bottom - gap) / rootPx}rem`;
      expect(panel.style.getPropertyValue("--menu-available-height")).toBe(
        remFor(100),
      );
      triggerBottom = 160;
      await waitFor(() => {
        expect(panel.style.getPropertyValue("--menu-available-height")).toBe(
          remFor(160),
        );
      });
    } finally {
      rect.mockRestore();
      innerHeight.mockRestore();
    }
  });

  it("shows the panel as a popover and keeps it inside the viewport", async () => {
    const user = userEvent.setup();
    const innerWidth = vi.spyOn(window, "innerWidth", "get");
    innerWidth.mockReturnValue(393);
    const innerHeight = vi.spyOn(window, "innerHeight", "get");
    innerHeight.mockReturnValue(659);
    const rect = vi
      .spyOn(HTMLButtonElement.prototype, "getBoundingClientRect")
      .mockImplementation(
        () =>
          ({
            left: 16,
            right: 130,
            top: 500,
            bottom: 540,
          }) as unknown as DOMRect,
      );
    const width = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(240);
    const show = vi.spyOn(HTMLElement.prototype, "showPopover");
    try {
      render(<Fixture />);
      await user.click(screen.getByRole("button", { name: "Open" }));
      const panel = screen.getByRole("menu", { name: "Test menu" });
      expect(show).toHaveBeenCalledTimes(1);
      expect(show.mock.contexts[0]).toBe(panel);
      expect(panel.style.left).toBe(`${0.5 * 16}px`);
    } finally {
      show.mockRestore();
      width.mockRestore();
      rect.mockRestore();
      innerHeight.mockRestore();
      innerWidth.mockRestore();
    }
  });

  it("scrolls the focused menuitem into the panel", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    try {
      render(<Fixture />);
      await user.click(screen.getByRole("button", { name: "Open" }));
      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
      });
      scrollIntoView.mockClear();
      await user.keyboard("{End}");
      expect(screen.getByRole("menuitem", { name: "Two" })).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it("includes checkbox and radio menu items in keyboard traversal", async () => {
    const user = userEvent.setup();
    function ChoiceFixture() {
      const [open, setOpen] = useState(false);
      return (
        <Menu
          open={open}
          onOpenChange={setOpen}
          label="Choices"
          trigger={(t) => (
            <button type="button" ref={t.ref} onClick={t.onClick}>
              Open choices
            </button>
          )}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked="true"
            tabIndex={0}
          >
            Radio
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked="false"
            tabIndex={0}
          >
            Checkbox
          </button>
        </Menu>
      );
    }

    render(<ChoiceFixture />);
    await user.click(screen.getByRole("button", { name: "Open choices" }));
    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: "Radio" }),
      ).toHaveFocus();
    });
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Checkbox" }),
    ).toHaveFocus();
  });

  it("Escape closes menu without dismissing an open BottomSheet", async () => {
    const user = userEvent.setup();
    render(<SheetWithMenu />);
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(menuOpen()).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuOpen()).toBe(false);
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeTruthy();
    expect(screen.queryByTestId("sheet-closed")).toBeNull();
  });

  it("exposes a shortcut to assistive tech while the kbd stays visual", () => {
    render(
      <MenuItem shortcut="⌘⇧B" keyShortcuts="Meta+Shift+B">
        Bounce…
      </MenuItem>,
    );
    const item = screen.getByRole("menuitem", { name: "Bounce…" });
    expect(item).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+B");
    expect(item.querySelector("kbd")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps a disabled item focusable, says why and does not select", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <div role="menu" aria-label="Track">
        <MenuItem disabledReason="Select a track first." onSelect={onSelect}>
          Remove track
        </MenuItem>
      </div>,
    );
    const item = screen.getByRole("menuitem", {
      name: /Remove track/,
      description: "Select a track first.",
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toBeDisabled();
    expect(screen.getByText("Select a track first.")).toBeVisible();
    await user.click(item);
    expect(onSelect).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("is a radio with its state when it says it is checked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <div role="menu" aria-label="Where">
        <MenuItem checked onSelect={onSelect}>
          At the end
        </MenuItem>
        <MenuItem checked={false}>At the start</MenuItem>
        <MenuItem>Plain</MenuItem>
      </div>,
    );
    expect(
      screen.getByRole("menuitemradio", { name: "At the end" }),
    ).toBeChecked();
    expect(
      screen.getByRole("menuitemradio", { name: "At the start" }),
    ).not.toBeChecked();
    const plain = screen.getByRole("menuitem", { name: "Plain" });
    expect(plain).not.toHaveAttribute("aria-checked");
    await user.click(screen.getByRole("menuitemradio", { name: "At the end" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });
});
