import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, type Mock, vi } from "vitest";
import { ScrubField, type ScrubFieldProps } from "./ScrubField";

type Calls = {
  onPreview: Mock<(value: number) => void>;
  onCommit: Mock<(value: number) => void>;
  onCancel: Mock<() => void>;
};

function Harness(props: Partial<ScrubFieldProps> & { calls: Calls }) {
  const { calls, ...rest } = props;
  const [committed, setCommitted] = useState<number | null>(
    rest.value === undefined ? 100 : rest.value,
  );
  const [shown, setShown] = useState(committed);
  const field = {
    label: "Offset",
    unit: "ms",
    ...rest,
    value: shown,
    onPreview: (next: number) => {
      calls.onPreview(next);
      setShown(next);
    },
    onCommit: (next: number) => {
      calls.onCommit(next);
      setCommitted(next);
      setShown(next);
    },
    onCancel: () => {
      calls.onCancel();
      setShown(committed);
    },
  } as ScrubFieldProps;
  return <ScrubField {...field} />;
}

function setup(props: Partial<ScrubFieldProps> = {}) {
  const calls: Calls = {
    onPreview: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };
  render(<Harness {...props} calls={calls} />);
  return {
    calls,
    field: () => screen.getByRole("spinbutton", { name: "Offset" }),
  };
}

const dragBy = (
  field: HTMLElement,
  pixels: number,
  modifiers: { shiftKey?: boolean; altKey?: boolean } = {},
) => {
  fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(field, { clientX: 110, pointerId: 1, ...modifiers });
  fireEvent.pointerMove(field, {
    clientX: 110 + pixels,
    pointerId: 1,
    ...modifiers,
  });
};

describe("ScrubField drag", () => {
  it("changes by one step per pixel and commits once on release", () => {
    const { calls, field } = setup();
    dragBy(field(), 25);
    expect(field()).toHaveAttribute("aria-valuenow", "125");
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onPreview).toHaveBeenLastCalledWith(125);
    expect(calls.onCommit).toHaveBeenCalledOnce();
    expect(calls.onCommit).toHaveBeenCalledWith(125);
  });

  it("moves ten times as fast with Shift", () => {
    const { calls, field } = setup();
    dragBy(field(), 5, { shiftKey: true });
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).toHaveBeenCalledWith(150);
  });

  it("moves a tenth as fast with Alt when the field has a decimal place", () => {
    const { calls, field } = setup({ decimals: 1 });
    dragBy(field(), 5, { altKey: true });
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).toHaveBeenCalledWith(100.5);
  });

  it("stops at the bounds and comes back as soon as the pointer does", () => {
    const { calls, field } = setup({ min: 0, max: 120 });
    dragBy(field(), 300);
    expect(field()).toHaveAttribute("aria-valuenow", "120");
    fireEvent.pointerMove(field(), { clientX: 110 + 290, pointerId: 1 });
    expect(field()).toHaveAttribute("aria-valuenow", "110");
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).toHaveBeenCalledWith(110);
  });

  it("drops the preview on Escape and commits nothing", () => {
    const { calls, field } = setup();
    dragBy(field(), 25);
    fireEvent.keyDown(field(), { key: "Escape" });
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCancel).toHaveBeenCalledOnce();
    expect(calls.onCommit).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("aria-valuenow", "100");
  });

  it("treats a drag that ends where it began as no change", () => {
    const { calls, field } = setup();
    dragBy(field(), 25);
    fireEvent.pointerMove(field(), { clientX: 110, pointerId: 1 });
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).not.toHaveBeenCalled();
    expect(calls.onCancel).toHaveBeenCalledOnce();
  });

  it("ignores a drag on a read-only field", () => {
    const { calls, field } = setup({ readOnly: true });
    dragBy(field(), 25);
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onPreview).not.toHaveBeenCalled();
    expect(calls.onCommit).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("aria-readonly", "true");
  });
});

describe("ScrubField keyboard", () => {
  it("steps by one, ten with Shift, a tenth with Alt", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ decimals: 1 });
    field().focus();
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(calls.onCommit.mock.calls).toEqual([[101], [111], [110.9]]);
  });

  it("commits each press as its own step and stays inside the bounds", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ min: 0, max: 101 });
    field().focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(calls.onCommit.mock.calls).toEqual([[101], [101]]);
  });

  it("jumps to the ends with Home and End", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ min: 0, max: 500 });
    field().focus();
    await user.keyboard("{End}{Home}");
    expect(calls.onCommit.mock.calls).toEqual([[500], [0]]);
  });

  it("does nothing on a read-only field", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ readOnly: true });
    field().focus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(calls.onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("ScrubField typing", () => {
  it("opens an input on click, commits a typed number on Enter and returns focus", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup();
    await user.click(field());
    const input = screen.getByRole("textbox", { name: "Offset" });
    expect(input).toHaveValue("100");
    await user.clear(input);
    await user.type(input, "250{Enter}");
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(250);
    expect(field()).toHaveFocus();
  });

  it("opens the input from the keyboard with Enter", async () => {
    const user = userEvent.setup();
    const { field } = setup();
    field().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Offset" })).toHaveFocus();
  });

  it("reverts on Escape", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup();
    await user.click(field());
    await user.type(screen.getByRole("textbox"), "9{Escape}");
    expect(calls.onCommit).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("aria-valuenow", "100");
  });

  it("keeps a bad number open, names the range and commits nothing on Enter", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ min: 0, max: 500 });
    await user.click(screen.getByRole("spinbutton"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "900{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a number from 0 to 500 ms",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(calls.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("commits a valid number when focus leaves and drops an invalid one", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ min: 0, max: 500 });
    await user.click(screen.getByRole("spinbutton"));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "40");
    await user.tab();
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(40);
    await user.click(screen.getByRole("spinbutton"));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "x");
    await user.tab();
    expect(calls.onCommit).toHaveBeenCalledOnce();
    expect(screen.getByRole("spinbutton")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
  });
});

describe("ScrubField states", () => {
  it("shows a reset dot only while the value differs from the default", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ defaultValue: 0 });
    await user.click(
      screen.getByRole("button", { name: "Reset Offset to 0 ms" }),
    );
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(0);
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it("draws the empty state and steps from the default", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ value: null, defaultValue: 20 });
    expect(field()).toHaveTextContent("Not set");
    expect(field()).not.toHaveAttribute("aria-valuenow");
    field().focus();
    await user.keyboard("{ArrowUp}");
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(21);
  });

  it("marks an outside error on the field and describes it", () => {
    const { field } = setup({ error: "The server refused 900 ms" });
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(field()).toHaveAccessibleDescription("The server refused 900 ms");
  });

  it("reads the value with its unit", () => {
    const { field } = setup({ value: -3, decimals: 1, unit: "dB" });
    expect(field()).toHaveAttribute("aria-valuetext", "−3.0 dB");
  });

  it("draws the level fill and the track rail from the range", () => {
    const level = render(
      <ScrubField
        variant="level"
        label="Level"
        value={-30}
        min={-60}
        max={0}
        unit="dB"
        onCommit={() => undefined}
      />,
    );
    const box = level.container.querySelector(".sys-scrub-box") as HTMLElement;
    expect(box.style.getPropertyValue("--sys-scrub-ratio")).toBe("0.5");
    expect(level.container.querySelector(".sys-scrub-fill")).not.toBeNull();
    level.unmount();
    const track = render(
      <ScrubField
        variant="track"
        label="Offset"
        value={0}
        min={-100}
        max={100}
        unit="ms"
        onCommit={() => undefined}
      />,
    );
    expect(track.container.querySelector(".sys-scrub-rail")).not.toBeNull();
    expect(track.container.querySelector(".sys-scrub-fill")).toBeNull();
  });
});
