import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LinkRow } from "./LinkRow";
import { middleTruncate } from "./linkText";
import { RoleChip } from "./RoleChip";
import { TimeField } from "./TimeField";

describe("RoleChip", () => {
  it("names the role without its text when compact", () => {
    render(<RoleChip access="commenter" compact />);
    expect(
      screen.getByRole("img", { name: "Commenter: can comment" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Commenter")).toBeNull();
  });
});

describe("LinkRow", () => {
  it("makes no link until Copy and says so", async () => {
    const onCopy = vi.fn();
    render(<LinkRow access="viewer" link={null} onCopy={onCopy} />);
    expect(screen.getByText("Made when you copy it")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("labels Copy by state and device", () => {
    const { rerender } = render(
      <LinkRow
        access="viewer"
        link="https://x.example/abc"
        copyState="copied"
        onCopy={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    rerender(
      <LinkRow
        access="viewer"
        link="https://x.example/abc"
        copyState="blocked"
        onCopy={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /^Press / })).toBeInTheDocument();
    rerender(
      <LinkRow
        access="viewer"
        link="https://x.example/abc"
        share
        onCopy={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("offers Refresh mix instead of a link when there is no mix", async () => {
    const onRefresh = vi.fn();
    render(
      <LinkRow
        access="viewer"
        link={null}
        noMix={{ onRefresh }}
        onCopy={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh mix" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("cuts the middle of a long link", () => {
    expect(middleTruncate("a".repeat(60))).toBe(
      `${"a".repeat(14)}…${"a".repeat(14)}`,
    );
    expect(middleTruncate("short")).toBe("short");
  });
});

describe("TimeField", () => {
  const setup = (
    props: Partial<React.ComponentProps<typeof TimeField>> = {},
  ) => {
    const onChange = vi.fn();
    render(
      <TimeField
        label="Gain"
        value={10}
        step={1}
        min={0}
        max={20}
        onChange={onChange}
        {...props}
      />,
    );
    return { onChange, input: screen.getByRole("textbox", { name: "Gain" }) };
  };

  it("steps with the arrows, ten times with Shift and a tenth with Alt", () => {
    const { onChange, input } = setup();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([11, 20, 9.9]);
  });

  it("commits typed values on Enter and reverts on Escape", async () => {
    const { onChange, input } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "30{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(20);
    await userEvent.clear(input);
    await userEvent.type(input, "3{Escape}");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("holds at the lower bound as well as the upper", async () => {
    const { onChange, input } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "-5{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("does not report a step that stays at the bound", () => {
    const { onChange, input } = setup({ value: 0 });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits what was typed when focus leaves", async () => {
    const { onChange, input } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "15");
    await userEvent.tab();
    expect(onChange).toHaveBeenLastCalledWith(15);
  });

  it("rejects text it cannot read", async () => {
    const { onChange, input } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "abc{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("scrubs by dragging the label", () => {
    const { onChange } = setup();
    const grip = screen.getByText("Gain");
    fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 108, pointerId: 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(12);
  });
});
