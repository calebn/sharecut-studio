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

const pointerTap = (
  target: HTMLElement,
  pointerType: "mouse" | "touch",
  pointerId = 1,
) => {
  const contact = {
    pointerId,
    pointerType,
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 10,
  };
  fireEvent.pointerDown(target, contact);
  fireEvent.pointerUp(target, contact);
};

const beginMouseSecondContact = (target: HTMLElement, pointerId = 2) => {
  fireEvent.pointerDown(target, {
    pointerId,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 10,
  });
  fireEvent.mouseDown(target, {
    detail: 2,
    button: 0,
    clientX: 100,
    clientY: 10,
  });
};

const finishMouseSecondContact = (target: HTMLElement, pointerId = 2) => {
  fireEvent.pointerUp(target, {
    pointerId,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 10,
  });
  fireEvent.click(target, { detail: 2, clientX: 100, clientY: 10 });
  fireEvent.doubleClick(target, { detail: 2, clientX: 100, clientY: 10 });
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

  it("snaps a drag, previews the snapped value and leaves arrow keys alone", () => {
    const { calls, field } = setup({
      value: 0,
      step: 1,
      snap: (v) => Math.round(v / 10) * 10,
    });
    dragBy(field(), 25);
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onPreview).toHaveBeenLastCalledWith(30);
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(30);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(calls.onCommit).toHaveBeenLastCalledWith(31);
  });

  it("rounds a snapped drag to the field's decimals and keeps it in bounds", () => {
    const { calls, field } = setup({
      value: 0,
      step: 1,
      decimals: 2,
      min: 0,
      max: 50,
      snap: () => 1.97525,
    });
    dragBy(field(), 5);
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(1.98);
  });

  it("takes several pixels of drag per step for a coarse field", () => {
    const { calls, field } = setup({ pixelsPerStep: 10 });
    dragBy(field(), 20);
    expect(field()).toHaveAttribute("aria-valuenow", "102");
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).toHaveBeenCalledWith(102);
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

  it("cancels a drag on an empty field that returns to its start", () => {
    const { calls, field } = setup({ value: null, defaultValue: 3 });
    dragBy(field(), 5);
    fireEvent.pointerMove(field(), { clientX: 110, pointerId: 1 });
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).not.toHaveBeenCalled();
    expect(calls.onCancel).toHaveBeenCalledOnce();
  });

  it("drops the preview when the field unmounts mid-drag", () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <ScrubField
        label="Offset"
        value={100}
        onCommit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const box = screen.getByRole("spinbutton");
    dragBy(box, 5);
    unmount();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("ignores a second pointer during a drag", () => {
    const { calls, field } = setup();
    dragBy(field(), 25);
    fireEvent.pointerDown(field(), { clientX: 50, pointerId: 2, button: 0 });
    fireEvent.pointerUp(field(), { pointerId: 2 });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(125);
  });

  it("drops the preview when the pointer capture is lost", () => {
    const { calls, field } = setup();
    dragBy(field(), 25);
    fireEvent.lostPointerCapture(field(), { pointerId: 1 });
    fireEvent.pointerMove(field(), { clientX: 200, pointerId: 1 });
    expect(calls.onCancel).toHaveBeenCalledOnce();
    expect(calls.onPreview).toHaveBeenCalledTimes(1);
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

  it("commits each press as its own step, stays inside the bounds and skips a press that changes nothing", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ min: 0, max: 102 });
    field().focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{End}");
    expect(calls.onCommit.mock.calls).toEqual([[101], [102]]);
  });

  it("commits nothing for Home at the minimum or Alt on a whole-number field", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ value: 0, min: 0, max: 500 });
    field().focus();
    await user.keyboard("{Home}{Alt>}{ArrowUp}{/Alt}");
    expect(calls.onCommit).not.toHaveBeenCalled();
  });

  it("jumps to the ends with Home and End", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ min: 0, max: 500 });
    field().focus();
    await user.keyboard("{End}{Home}");
    expect(calls.onCommit.mock.calls).toEqual([[500], [0]]);
  });

  it("ends at the value its own display shows when the maximum has more places", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({ min: 0, max: 3120.4567, decimals: 2 });
    field().focus();
    await user.keyboard("{End}");
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(3120.45);
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

describe("ScrubField keys against the window keymap", () => {
  it("keeps the keys it handles from reaching a window keydown listener", async () => {
    const user = userEvent.setup();
    const reached = vi.fn();
    window.onkeydown = reached;
    const { field } = setup({ min: 0, max: 500 });
    field().focus();
    await user.keyboard(
      "{ArrowUp}{ArrowDown}{ArrowLeft}{ArrowRight}{Home}{End}",
    );
    await user.keyboard("{F2}");
    expect(reached).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.keyboard("{Enter}");
    expect(reached).not.toHaveBeenCalled();
    window.onkeydown = null;
  });

  it("lets Escape reach the window when no drag is running, and stops it during one", () => {
    const reached = vi.fn();
    window.onkeydown = reached;
    const { field } = setup();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(reached).toHaveBeenCalledOnce();
    dragBy(field(), 25);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(reached).toHaveBeenCalledOnce();
    window.onkeydown = null;
  });
});

describe("ScrubField window keys", () => {
  it("takes a held arrow key as one step, not one per repeat", () => {
    const { calls, field } = setup();
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    fireEvent.keyDown(field(), { key: "ArrowUp", repeat: true });
    fireEvent.keyDown(field(), { key: "ArrowUp", repeat: true });
    expect(calls.onCommit).toHaveBeenCalledOnce();
  });

  it("refuses a typed fraction when integerOnly", async () => {
    const user = userEvent.setup();
    const strict = setup({ decimals: 0, integerOnly: true, min: 0, max: 100 });
    await user.click(strict.field());
    const input = screen.getByRole("textbox", { name: "Offset" });
    await user.clear(input);
    await user.type(input, "1.5{Enter}");
    expect(strict.calls.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("whole number");
  });

  it("steps from an empty value by default", () => {
    const { calls, field } = setup({ value: null, min: 0 });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(calls.onCommit).toHaveBeenCalledOnce();
  });
});

describe("ScrubField typing", () => {
  it("resets a level on a native mouse double-click after opening the input", () => {
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
      decimals: 1,
      unit: "dB",
    });
    const initial = field();
    pointerTap(initial, "mouse");
    fireEvent.click(initial, { detail: 1, clientX: 100, clientY: 10 });
    const input = screen.getByRole("textbox", { name: "Offset" });
    expect(input).toHaveFocus();

    beginMouseSecondContact(input);
    finishMouseSecondContact(input);

    expect(screen.queryByRole("textbox", { name: "Offset" })).toBeNull();
    expect(field()).toHaveAttribute("aria-valuenow", "0");
    expect(field()).toHaveFocus();
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("resets a level on a second touch after opening the input", () => {
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
      decimals: 1,
      unit: "dB",
    });
    pointerTap(field(), "touch");
    const input = screen.getByRole("textbox", { name: "Offset" });
    expect(input).toHaveFocus();

    fireEvent.click(input, {
      detail: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerDown(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.click(input, {
      detail: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 10,
    });

    expect(screen.queryByRole("textbox", { name: "Offset" })).toBeNull();
    expect(field()).toHaveAttribute("aria-valuenow", "0");
    expect(field()).toHaveFocus();
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps the touch reset candidate through retargeted compatibility mouse coordinates", () => {
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
      decimals: 1,
      unit: "dB",
    });

    const initial = field();
    fireEvent.pointerDown(initial, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 279,
      clientY: 38,
    });
    fireEvent.pointerUp(initial, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 279,
      clientY: 38,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    fireEvent.mouseDown(input, {
      detail: 1,
      button: 0,
      clientX: 266,
      clientY: 25,
    });
    fireEvent.pointerDown(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 279,
      clientY: 38,
    });
    fireEvent.pointerUp(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 279,
      clientY: 38,
    });

    expect(screen.queryByRole("textbox", { name: "Offset" })).toBeNull();
    expect(field()).toHaveAttribute("aria-valuenow", "0");
    expect(field()).toHaveFocus();
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps an empty level available for ordinary typing instead of resetting it", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({
      variant: "level",
      value: null,
      min: 0,
      max: 1,
      defaultValue: 1,
      decimals: 2,
    });
    fireEvent.pointerDown(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 100,
      clientY: 10,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    fireEvent.doubleClick(input, { detail: 2, clientX: 100, clientY: 10 });

    expect(screen.getByRole("textbox", { name: "Offset" })).toBe(input);
    expect(calls.onCommit).not.toHaveBeenCalled();
    await user.type(input, "0.7{Enter}");
    expect(field()).toHaveAttribute("aria-valuenow", "0.7");
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(0.7);
  });

  it("consumes a level reset at its configured default without committing", () => {
    const { calls, field } = setup({
      variant: "level",
      value: 0,
      min: -60,
      max: 12,
      defaultValue: 0,
    });
    pointerTap(field(), "mouse");
    const input = screen.getByRole("textbox", { name: "Offset" });
    beginMouseSecondContact(input);
    finishMouseSecondContact(input);

    expect(screen.queryByRole("textbox", { name: "Offset" })).toBeNull();
    expect(field()).toHaveAttribute("aria-valuenow", "0");
    expect(calls.onCommit).not.toHaveBeenCalled();
  });

  it("commits a configured nonzero level default once", () => {
    const { calls, field } = setup({
      variant: "level",
      value: 0.5,
      min: 0,
      max: 1,
      defaultValue: 1,
      decimals: 2,
    });
    pointerTap(field(), "mouse");
    const input = screen.getByRole("textbox", { name: "Offset" });
    beginMouseSecondContact(input);
    finishMouseSecondContact(input);

    expect(screen.queryByRole("textbox", { name: "Offset" })).toBeNull();
    expect(field()).toHaveAttribute("aria-valuenow", "1");
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["move", "cancel"] as const)(
    "does not reset after the second mouse contact %s",
    (ending) => {
      const { calls, field } = setup({
        variant: "level",
        value: -6,
        min: -60,
        max: 12,
        defaultValue: 0,
      });
      fireEvent.pointerDown(field(), {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        clientX: 100,
        clientY: 10,
      });
      fireEvent.pointerUp(field(), {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        clientX: 100,
        clientY: 10,
      });
      const input = screen.getByRole("textbox", { name: "Offset" });
      fireEvent.pointerDown(input, {
        pointerId: 2,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        clientX: 100,
        clientY: 10,
      });
      fireEvent.mouseDown(input, {
        detail: 2,
        button: 0,
        clientX: 100,
        clientY: 10,
      });
      if (ending === "move") {
        fireEvent.pointerMove(input, {
          pointerId: 2,
          pointerType: "mouse",
          isPrimary: true,
          clientX: 104,
          clientY: 10,
        });
        fireEvent.pointerUp(input, {
          pointerId: 2,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          clientX: 104,
          clientY: 10,
        });
        fireEvent.doubleClick(input, { detail: 2, clientX: 104, clientY: 10 });
      } else {
        fireEvent.pointerCancel(input, {
          pointerId: 2,
          pointerType: "mouse",
        });
        fireEvent.doubleClick(input, { detail: 2, clientX: 100, clientY: 10 });
      }

      expect(screen.getByRole("textbox", { name: "Offset" })).toBe(input);
      expect(calls.onCommit).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "secondary button",
      pointerType: "mouse",
      isPrimary: true,
      button: 1,
    },
    { name: "mixed pointer", pointerType: "touch", isPrimary: true, button: 0 },
    {
      name: "nonprimary contact",
      pointerType: "mouse",
      isPrimary: false,
      button: 0,
    },
  ])("ignores a $name second contact", ({ pointerType, isPrimary, button }) => {
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
    });
    fireEvent.pointerDown(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    fireEvent.pointerDown(input, {
      pointerId: 2,
      pointerType,
      isPrimary,
      button,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.mouseDown(input, {
      detail: 2,
      button,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(input, {
      pointerId: 2,
      pointerType,
      isPrimary,
      button,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.doubleClick(input, { detail: 2, clientX: 100, clientY: 10 });

    expect(screen.getByRole("textbox", { name: "Offset" })).toBe(input);
    expect(calls.onCommit).not.toHaveBeenCalled();
  });

  it("keeps an edited level as text instead of treating its next double-click as reset", async () => {
    const user = userEvent.setup();
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
      decimals: 1,
      unit: "dB",
    });
    fireEvent.pointerDown(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 100,
      clientY: 10,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    await user.clear(input);
    await user.type(input, "-4.5");
    fireEvent.doubleClick(input, { detail: 2, clientX: 100, clientY: 10 });

    expect(screen.getByRole("textbox", { name: "Offset" })).toHaveValue("-4.5");
    expect(calls.onCommit).not.toHaveBeenCalled();
    await user.tab();
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(-4.5);
  });

  it("rejects a moved second touch without closing the level input", () => {
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
    });
    fireEvent.pointerDown(field(), {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(field(), {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 10,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    fireEvent.pointerDown(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerMove(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      clientX: 111,
      clientY: 10,
    });
    fireEvent.pointerUp(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      clientX: 111,
      clientY: 10,
    });

    expect(screen.getByRole("textbox", { name: "Offset" })).toBe(input);
    expect(calls.onCommit).not.toHaveBeenCalled();
  });

  it("expires a touch reset when the second contact starts after its window", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
    });
    fireEvent.pointerDown(field(), {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(field(), {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    clock.mockReturnValue(1_350);
    fireEvent.pointerDown(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(input, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    clock.mockRestore();

    expect(screen.getByRole("textbox", { name: "Offset" })).toBe(input);
    expect(calls.onCommit).not.toHaveBeenCalled();
  });

  it("leaves mouse double-click timing to the native event", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
    });
    fireEvent.pointerDown(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    fireEvent.pointerDown(input, {
      pointerId: 2,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    clock.mockReturnValue(2_000);
    fireEvent.mouseDown(input, {
      detail: 2,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(input, {
      pointerId: 2,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.doubleClick(input, { detail: 2, clientX: 100, clientY: 10 });
    clock.mockRestore();

    expect(screen.queryByRole("textbox", { name: "Offset" })).toBeNull();
    expect(calls.onCommit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("does not arm a level reset without a configured default", () => {
    const { calls, field } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
    });
    fireEvent.pointerDown(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerUp(field(), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 100,
      clientY: 10,
    });
    const input = screen.getByRole("textbox", { name: "Offset" });
    fireEvent.doubleClick(input, { detail: 2, clientX: 100, clientY: 10 });

    expect(screen.getByRole("textbox", { name: "Offset" })).toBe(input);
    expect(calls.onCommit).not.toHaveBeenCalled();
  });

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

  it("with skipUnchanged commits nothing for text left as it was shown, even after the value refreshes", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const props = { label: "Offset", unit: "s", onCommit, skipUnchanged: true };
    const { rerender } = render(<ScrubField {...props} value={1.5} />);
    screen.getByRole("spinbutton", { name: "Offset" }).focus();
    await user.keyboard("{Enter}");
    rerender(<ScrubField {...props} value={2.5} />);
    await user.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("without skipUnchanged an unchanged Enter on a refreshed value commits as before", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const props = { label: "Offset", unit: "s", onCommit };
    const { rerender } = render(<ScrubField {...props} value={1.5} />);
    screen.getByRole("spinbutton", { name: "Offset" }).focus();
    await user.keyboard("{Enter}");
    rerender(<ScrubField {...props} value={2.5} />);
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("with commitUnchanged Enter on the shown value commits it, and leaving by blur does not", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ScrubField
        label="Offset"
        unit="s"
        value={2}
        onCommit={onCommit}
        commitUnchanged
      />,
    );
    const open = () => {
      screen.getByRole("spinbutton", { name: "Offset" }).focus();
      return user.keyboard("{Enter}");
    };
    await open();
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
    await open();
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(2);
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

  it("announces a bad number once on Enter, not on each keystroke", async () => {
    const user = userEvent.setup();
    setup({ min: 0, max: 500 });
    await user.click(screen.getByRole("spinbutton"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "900");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toHaveAccessibleDescription(
      "Enter a number from 0 to 500 ms",
    );
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.type(input, "1");
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("keeps focus on the field after the reset dot is used", async () => {
    const user = userEvent.setup();
    setup({ defaultValue: 0 });
    await user.click(
      screen.getByRole("button", { name: "Reset Offset to 0 ms" }),
    );
    expect(screen.getByRole("spinbutton")).toHaveFocus();
  });

  it("discards an edited level draft when its reset dot is used", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      variant: "level",
      value: -6,
      min: -60,
      max: 12,
      defaultValue: 0,
      decimals: 1,
      unit: "dB",
    });
    await user.click(screen.getByRole("spinbutton", { name: "Offset" }));
    const input = screen.getByRole("textbox", { name: "Offset" });
    await user.clear(input);
    await user.type(input, "-3.5");
    await user.click(
      screen.getByRole("button", { name: "Reset Offset to 0.0 dB" }),
    );

    expect(calls.onCommit.mock.calls).toEqual([[0]]);
    expect(screen.queryByRole("textbox", { name: "Offset" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Offset" })).toHaveFocus();
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

  describe("multiplicative", () => {
    const factor = { multiplicative: true, step: 2, min: 1, max: 16, value: 4 };

    it("multiplies and divides by the step per arrow press, inside its bounds", async () => {
      const { calls, field } = setup(factor);
      field().focus();
      await userEvent.keyboard("{ArrowUp}");
      expect(calls.onCommit).toHaveBeenLastCalledWith(8);
      await userEvent.keyboard("{ArrowUp}{ArrowUp}");
      expect(calls.onCommit).toHaveBeenLastCalledWith(16);
      await userEvent.keyboard("{ArrowDown}");
      expect(calls.onCommit).toHaveBeenLastCalledWith(8);
      await userEvent.keyboard("{Home}{ArrowDown}");
      expect(calls.onCommit).toHaveBeenLastCalledWith(1);
      expect(calls.onCommit).toHaveBeenCalledTimes(4);
    });

    it("drags by one factor per eight pixels", () => {
      const { calls, field } = setup(factor);
      dragBy(field(), 8);
      fireEvent.pointerUp(field(), { pointerId: 1 });
      expect(calls.onCommit).toHaveBeenCalledWith(8);
    });

    it("takes three factors per key with Shift, not ten", async () => {
      const { calls, field } = setup({ ...factor, value: 1 });
      field().focus();
      await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
      expect(calls.onCommit).toHaveBeenLastCalledWith(8);
    });

    it("takes three factors per eight pixels of drag with Shift", () => {
      const { calls, field } = setup({ ...factor, value: 1 });
      dragBy(field(), 8, { shiftKey: true });
      fireEvent.pointerUp(field(), { pointerId: 1 });
      expect(calls.onCommit).toHaveBeenCalledWith(8);
    });
  });
});

describe("ScrubField commitOnUnmount", () => {
  const mount = (commitOnUnmount: boolean) => {
    const onCommit = vi.fn();
    const view = render(
      <ScrubField
        label="Offset"
        value={5}
        max={100}
        commitOnUnmount={commitOnUnmount}
        onCommit={onCommit}
      />,
    );
    return { onCommit, view };
  };

  it("commits a valid typed value when the field goes away", async () => {
    const { onCommit, view } = mount(true);
    await userEvent.click(screen.getByRole("spinbutton", { name: "Offset" }));
    await userEvent.keyboard("12");
    view.unmount();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(12);
  });

  it("with skipUnchanged leaves a value opened and not edited alone when the field goes away", async () => {
    const onCommit = vi.fn();
    const view = render(
      <ScrubField
        label="Offset"
        value={5.1234}
        decimals={2}
        skipUnchanged
        commitOnUnmount
        onCommit={onCommit}
      />,
    );
    await userEvent.click(screen.getByRole("spinbutton", { name: "Offset" }));
    view.unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("with skipUnchanged treats a draft retyped to its opened text as unchanged", async () => {
    const onCommit = vi.fn();
    const view = render(
      <ScrubField
        label="Offset"
        value={5.1234}
        decimals={2}
        skipUnchanged
        commitOnUnmount
        onCommit={onCommit}
      />,
    );
    await userEvent.click(screen.getByRole("spinbutton", { name: "Offset" }));
    await userEvent.keyboard("{Control>}a{/Control}9");
    await userEvent.keyboard("{Control>}a{/Control}5.12");
    view.unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("drops a rejected value, and does nothing unless asked", async () => {
    const rejected = mount(true);
    await userEvent.click(screen.getByRole("spinbutton", { name: "Offset" }));
    await userEvent.keyboard("500");
    rejected.view.unmount();
    expect(rejected.onCommit).not.toHaveBeenCalled();
    const off = mount(false);
    await userEvent.click(screen.getByRole("spinbutton", { name: "Offset" }));
    await userEvent.keyboard("12");
    off.view.unmount();
    expect(off.onCommit).not.toHaveBeenCalled();
  });
});
