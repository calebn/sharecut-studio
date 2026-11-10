import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import type { JoinMic } from "./joinSheetModel";
import { MicRow } from "./MicRow";

// Lets one test hold back effects so the commit that carries a new `locked`
// prop can be observed before the close-on-lock effect runs.
const effects = vi.hoisted(() => ({ paused: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) =>
      actual.useEffect(() => (effects.paused ? undefined : fn()), deps),
  };
});

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

const css = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../styles/partials/system-record.css",
  ),
  "utf8",
);

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
    // Menu focus moves on a frame, so wait for it before sending keys.
    await waitFor(() =>
      expect(
        within(menu).getByRole("menuitemradio", { name: "Default" }),
      ).toHaveFocus(),
    );
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onInputChange).toHaveBeenCalledWith("built-in");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("treats an input that is no longer listed as the default", async () => {
    render(<MicRow mic={ready({ inputId: "gone" })} notes={[]} />);
    expect(chip()).toHaveAccessibleName("Input: Default");
    await userEvent.click(chip());
    expect(
      screen.getByRole("menuitemradio", { name: "Default" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getAllByRole("menuitemradio", { checked: true }),
    ).toHaveLength(1);
  });

  it("opens with Space, marks the current input and jumps with Home and End", async () => {
    const onInputChange = vi.fn();
    render(<MicRow mic={ready()} notes={[]} onInputChange={onInputChange} />);
    chip().focus();
    await userEvent.keyboard(" ");
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("menuitemradio", { name: "USB Condenser" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemradio", { name: "MacBook Mic" }),
    ).toHaveAttribute("aria-checked", "false");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: "Default" }),
      ).toHaveFocus(),
    );
    await userEvent.keyboard("{End}");
    expect(
      screen.getByRole("menuitemradio", { name: "MacBook Mic" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(
      screen.getByRole("menuitemradio", { name: "Default" }),
    ).toHaveFocus();
    expect(onInputChange).not.toHaveBeenCalled();
  });

  it("closes on an outside click without picking", async () => {
    const onInputChange = vi.fn();
    render(
      <>
        <button type="button">Elsewhere</button>
        <MicRow mic={ready()} notes={[]} onInputChange={onInputChange} />
      </>,
    );
    await userEvent.click(chip());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onInputChange).not.toHaveBeenCalled();
  });

  it("stays open to change while the new input is still switching", async () => {
    render(<MicRow mic={ready({ switching: true })} notes={[]} />);
    expect(chip()).toBeEnabled();
    await userEvent.click(chip());
    expect(screen.getByRole("menu")).toBeInTheDocument();
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

  it("closes the open menu when the lock flips on", async () => {
    const onInputChange = vi.fn();
    const { rerender } = render(
      <MicRow mic={ready()} notes={[]} onInputChange={onInputChange} />,
    );
    await userEvent.click(chip());
    rerender(
      <MicRow
        mic={ready({ inputLocked: true })}
        notes={[]}
        onInputChange={onInputChange}
      />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onInputChange).not.toHaveBeenCalled();
  });

  it("commits nothing when a row is picked after the lock flips but before the close effect runs", async () => {
    const onInputChange = vi.fn();
    const { rerender } = render(
      <MicRow mic={ready()} notes={[]} onInputChange={onInputChange} />,
    );
    await userEvent.click(chip());
    effects.paused = true;
    try {
      rerender(
        <MicRow
          mic={ready({ inputLocked: true })}
          notes={[]}
          onInputChange={onInputChange}
        />,
      );
    } finally {
      effects.paused = false;
    }
    // The close effect was held back, so the row is still attached.
    const row = screen.getByRole("menuitemradio", { name: "MacBook Mic" });
    await userEvent.click(row);
    expect(onInputChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the menu with ArrowDown or ArrowUp on the closed chip", async () => {
    render(<MicRow mic={ready()} notes={[]} />);
    chip().focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.keyboard("{ArrowUp}");
    expect(chip()).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a device with an empty id apart from Default", async () => {
    const devices = [{ id: "", label: "Unnamed mic" }, ...DEVICES];
    render(<MicRow mic={ready({ devices, inputId: "" })} notes={[]} />);
    expect(chip()).toHaveAccessibleName("Input: Default");
    await userEvent.click(chip());
    expect(
      screen.getByRole("menuitemradio", { name: "Default" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getAllByRole("menuitemradio", { checked: true }),
    ).toHaveLength(1);
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

  it("sizes the chip and its menu rows to --touch-min on every pointer", () => {
    expect(css).toMatch(
      /\.sys-mic-input-root \{\s*--menu-item-min-block-size: var\(--touch-min\);/,
    );
    expect(css).toMatch(
      /\.sys-mic-input \{[^}]*min-block-size: var\(--touch-min\);/,
    );
  });
});
