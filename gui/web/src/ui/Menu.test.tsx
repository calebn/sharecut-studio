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
    await expectNoA11yViolations(container);
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
});
