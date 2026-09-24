import { render, screen, waitFor } from "@testing-library/react";
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
