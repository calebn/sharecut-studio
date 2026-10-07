import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BottomSheet } from "./BottomSheet";
import { Menu, MenuItem } from "./Menu";
import { peekMenuOpen } from "./menuGate";

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
      <MenuItem onSelect={() => setOpen(false)}>Two</MenuItem>
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
    if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
      HTMLElement.prototype.scrollIntoView = () => undefined;
    }
  });

  it("opens, traps arrows among menuitems, closes on Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(peekMenuOpen()).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    });
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Two" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(peekMenuOpen()).toBe(false);
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    await expectNoA11yViolations(container);
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
    expect(peekMenuOpen()).toBe(false);
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
        () => ({ bottom: triggerBottom }) as unknown as DOMRect,
      );
    try {
      render(<Fixture />);
      await user.click(screen.getByRole("button", { name: "Open" }));
      const panel = screen.getByRole("menu", { name: "Test menu" });
      const rootPx = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const remFor = (bottom: number) =>
        `${(800 - bottom - 0.25 * rootPx) / rootPx}rem`;
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
    expect(peekMenuOpen()).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(peekMenuOpen()).toBe(false);
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
});
