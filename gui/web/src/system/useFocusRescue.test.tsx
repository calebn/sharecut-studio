import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, Menu, MenuItem } from "../ui";
import { useFocusRescue } from "./useFocusRescue";

function Host() {
  const [shown, setShown] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useFocusRescue(box, () => () => box.current?.querySelector("input"));
  return (
    <div>
      <div ref={box}>
        {shown ? (
          <button type="button" onClick={() => setShown(false)}>
            Go
          </button>
        ) : null}
        <input aria-label="Safe place" />
      </div>
      <button type="button" onClick={() => setShown(false)}>
        Outside
      </button>
    </div>
  );
}

function MenuHost({ onPick }: { onPick: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useFocusRescue(box, () => () => box.current);
  return (
    <div ref={box} tabIndex={-1} aria-label="Box" role="group">
      <Menu
        open={open}
        onOpenChange={setOpen}
        label="Actions"
        trigger={(props) => (
          <Button {...props} aria-label="More actions">
            More
          </Button>
        )}
      >
        <MenuItem
          onSelect={() => {
            setOpen(false);
            onPick();
          }}
        >
          Pick
        </MenuItem>
      </Menu>
    </div>
  );
}

describe("useFocusRescue", () => {
  it("moves focus to the anchor when the focused element is removed", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Safe place"));
  });

  it("does not take focus that moved elsewhere", async () => {
    render(<Host />);
    const go = screen.getByRole("button", { name: "Go" });
    go.focus();
    const outside = screen.getByRole("button", { name: "Outside" });
    await userEvent.click(outside);
    expect(document.activeElement).toBe(outside);
    expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
  });

  it("leaves focus alone when it was never inside the container", async () => {
    render(<Host />);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    await userEvent.click(outside);
    expect(document.activeElement).toBe(outside);
  });

  it("does not act on a blur to nowhere while the element stays", async () => {
    render(<Host />);
    const go = screen.getByRole("button", { name: "Go" });
    go.focus();
    act(() => go.blur());
    await Promise.resolve();
    expect(document.activeElement).toBe(document.body);
    act(() => screen.getByRole("button", { name: "Outside" }).click());
    expect(document.activeElement).toBe(document.body);
  });

  it("removes its document listeners on unmount", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Host />);
    const added = add.mock.calls.filter(([type]) =>
      ["focusin", "focusout"].includes(type),
    );
    expect(added).toHaveLength(2);
    unmount();
    for (const [type, listener] of added) {
      expect(remove).toHaveBeenCalledWith(type, listener);
    }
    add.mockRestore();
    remove.mockRestore();
  });

  it("hands focus to the menu trigger, not the container, when a menu item goes", async () => {
    const onPick = vi.fn();
    render(<MenuHost onPick={onPick} />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    await userEvent.click(trigger);
    const item = await screen.findByRole("menuitem", { name: "Pick" });
    act(() => item.focus());
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    const again = await screen.findByRole("menuitem", { name: "Pick" });
    act(() => again.focus());
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });
});
