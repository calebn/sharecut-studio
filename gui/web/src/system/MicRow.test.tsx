import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import type { JoinMic } from "./joinSheetModel";
import { MicRow } from "./MicRow";

const DEVICES = [
  { id: "usb", label: "USB Condenser" },
  { id: "built-in", label: "MacBook Mic" },
];

const ready = (extra: Partial<Extract<JoinMic, { status: "ready" }>> = {}) =>
  ({
    status: "ready",
    input: "USB Condenser",
    level: 0.2,
    devices: DEVICES,
    inputId: "usb",
    ...extra,
  }) satisfies JoinMic;

const chip = () => screen.getByRole("button", { name: /^Input:/ });

describe("MicRow input chip", () => {
  it("names the current input and shows the default when none is picked", () => {
    const { rerender } = render(<MicRow mic={ready()} notes={[]} />);
    expect(chip()).toHaveAccessibleName("Input: USB Condenser");
    rerender(<MicRow mic={ready({ inputId: "" })} notes={[]} />);
    expect(chip()).toHaveAccessibleName("Input: Default");
  });

  it("opens from the keyboard, picks with Enter and returns focus to the chip", async () => {
    const onInputChange = vi.fn();
    render(<MicRow mic={ready()} notes={[]} onInputChange={onInputChange} />);
    chip().focus();
    await userEvent.keyboard("{Enter}");
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Input" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onInputChange).toHaveBeenCalledWith("built-in");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape without picking and restores focus", async () => {
    const onInputChange = vi.fn();
    render(<MicRow mic={ready()} notes={[]} onInputChange={onInputChange} />);
    await userEvent.click(chip());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip()).toHaveFocus();
    expect(onInputChange).not.toHaveBeenCalled();
  });

  it("locks the chip with the reason described, and never opens", async () => {
    render(
      <MicRow
        mic={ready({ inputLocked: true })}
        notes={[]}
        onInputChange={vi.fn()}
      />,
    );
    expect(chip()).toBeDisabled();
    expect(chip()).toHaveAccessibleDescription(
      "Can't change while a take is running.",
    );
    await userEvent.click(chip());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps a lost input's chip usable between takes", async () => {
    const onInputChange = vi.fn();
    render(
      <MicRow
        mic={{ status: "lost", devices: DEVICES, inputId: "usb" }}
        notes={[]}
        onInputChange={onInputChange}
      />,
    );
    await userEvent.click(chip());
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: "Default" }),
    );
    expect(onInputChange).toHaveBeenCalledWith("");
  });

  it("renders no chip before the mic is ready or without devices", () => {
    const { rerender } = render(<MicRow mic={{ status: "idle" }} notes={[]} />);
    expect(screen.queryByRole("button", { name: /^Input:/ })).toBeNull();
    rerender(<MicRow mic={ready({ devices: undefined })} notes={[]} />);
    expect(screen.queryByRole("button", { name: /^Input:/ })).toBeNull();
  });

  it("has no axe violations closed or open", async () => {
    const { container } = render(<MicRow mic={ready()} notes={[]} />);
    await expectNoA11yViolations(container);
    await userEvent.click(chip());
    await expectNoA11yViolations(container);
  });
});
