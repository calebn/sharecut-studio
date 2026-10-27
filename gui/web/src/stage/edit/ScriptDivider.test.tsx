import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScriptDivider } from "./ScriptDivider";

function mount(widthRem = 25) {
  const onResize = vi.fn();
  const onReset = vi.fn();
  render(
    <ScriptDivider widthRem={widthRem} onResize={onResize} onReset={onReset} />,
  );
  return {
    onResize,
    onReset,
    divider: screen.getByRole("separator", { name: "Resize Script" }),
  };
}

describe("ScriptDivider", () => {
  it("names its range for assistive tech", () => {
    const { divider } = mount();
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveAttribute("aria-valuemin", "20");
    expect(divider).toHaveAttribute("aria-valuemax", "40");
    expect(divider).toHaveAttribute("aria-valuenow", "25");
  });

  it("moves 1 rem on an arrow and 4 rem with Shift; Left widens the pane", async () => {
    const user = userEvent.setup();
    const { divider, onResize } = mount();
    divider.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onResize).toHaveBeenLastCalledWith(26);
    await user.keyboard("{ArrowRight}");
    expect(onResize).toHaveBeenLastCalledWith(24);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(onResize).toHaveBeenLastCalledWith(29);
  });

  it("goes to its smallest on Home and largest on End, without reaching the keymap", async () => {
    const user = userEvent.setup();
    const { divider, onResize } = mount();
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);
    divider.focus();
    await user.keyboard("{Home}");
    expect(onResize).toHaveBeenLastCalledWith(20);
    await user.keyboard("{End}");
    expect(onResize).toHaveBeenLastCalledWith(40);
    document.removeEventListener("keydown", bubbled);
    expect(bubbled).not.toHaveBeenCalled();
  });

  it("resets on Enter and on double-click", async () => {
    const user = userEvent.setup();
    const { divider, onReset } = mount();
    divider.focus();
    await user.keyboard("{Enter}");
    expect(onReset).toHaveBeenCalledTimes(1);
    await user.dblClick(divider);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("drags: moving left grows the Script pane", () => {
    const { divider, onResize } = mount();
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 800, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 720 });
    // 80 px left at a 16 px root is 5 rem wider.
    expect(onResize).toHaveBeenLastCalledWith(30);
    fireEvent.pointerUp(divider, { pointerId: 1 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 600 });
    expect(onResize).toHaveBeenCalledTimes(1);
  });
});
