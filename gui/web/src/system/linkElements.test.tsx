import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LinkRow } from "./LinkRow";
import { middleTruncate } from "./linkText";
import { RoleChip } from "./RoleChip";
import { TimeField } from "./TimeField";

describe("RoleChip", () => {
  it.each([
    ["viewer", "Viewer: can listen", "Viewer"],
    ["commenter", "Commenter: can comment", "Commenter"],
    ["editor", "Editor: can edit", "Editor"],
  ] as const)("names %s and shows its word", (access, name, word) => {
    render(<RoleChip access={access} />);
    expect(screen.getByRole("img", { name })).toBeInTheDocument();
    expect(screen.getByText(word)).toBeInTheDocument();
  });

  it("names the role without its text when compact", () => {
    render(<RoleChip access="commenter" compact />);
    expect(
      screen.getByRole("img", { name: "Commenter: can comment" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Commenter")).toBeNull();
  });
});

describe("LinkRow", () => {
  const LINK = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";

  it("shows the link cut in the middle, and nothing when nobody opened it", () => {
    render(<LinkRow access="viewer" link={LINK} onCopy={() => {}} />);
    expect(screen.getByText(middleTruncate(LINK))).toBeInTheDocument();
    expect(screen.queryByText(LINK)).toBeNull();
    expect(screen.queryByRole("img", { name: /Opened by/ })).toBeNull();
  });

  it("shows the key to press when the clipboard is blocked", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        copyState="blocked"
        onCopy={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Press .*C$/ }),
    ).toBeInTheDocument();
  });

  it("copies from the keyboard", async () => {
    const onCopy = vi.fn();
    render(<LinkRow access="viewer" link={LINK} onCopy={onCopy} />);
    screen.getByRole("button", { name: "Copy" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("names who opened it, shows the note and the whole link on hover", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        note="Pinned to Rough cut"
        openedBy={[{ name: "Rosa" }, { name: "Jon" }]}
        onCopy={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Opened by Rosa, Jon" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pinned to Rough cut")).toBeInTheDocument();
    expect(screen.getByTitle(LINK)).toBeInTheDocument();
  });

  it("marks the row after an export and drops the role word on phone", () => {
    const { container } = render(
      <LinkRow
        access="commenter"
        link={LINK}
        highlight
        compact
        onCopy={() => {}}
      />,
    );
    expect(container.querySelector('[data-highlight="true"]')).not.toBeNull();
    expect(screen.queryByText("Commenter")).toBeNull();
    expect(
      screen.getByRole("img", { name: "Commenter: can comment" }),
    ).toBeInTheDocument();
  });

  it("shows the copy state on the row and selects a blocked link", () => {
    const { container, rerender } = render(
      <LinkRow
        access="viewer"
        link={LINK}
        copyState="blocked"
        onCopy={() => {}}
      />,
    );
    expect(container.querySelector('[data-copy="blocked"]')).not.toBeNull();
    expect(container.querySelector("[data-selected]")).not.toBeNull();
    rerender(<LinkRow access="viewer" link={LINK} onCopy={() => {}} />);
    expect(container.querySelector("[data-selected]")).toBeNull();
  });

  it("keeps Share on phone even when the clipboard is blocked", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        share
        copyState="blocked"
        onCopy={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

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
    expect(input).toHaveValue("10");
  });

  it("shows the formatted, clamped value again after Enter, an arrow or blur", async () => {
    const { input } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "30{Enter}");
    expect(input).toHaveValue("10");
    await userEvent.clear(input);
    await userEvent.type(input, "7");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("10");
    await userEvent.clear(input);
    await userEvent.type(input, "7");
    await userEvent.tab();
    expect(input).toHaveValue("10");
  });

  it("steps by one by default and keeps the arrow from moving the caret", () => {
    const { onChange, input } = setup({ step: undefined });
    const notPrevented = fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(notPrevented).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(11);
  });

  it("captures the pointer and stops scrubbing on release or cancel", () => {
    const { onChange } = setup();
    const grip = screen.getByText("Gain");
    const capture = vi.fn();
    Object.assign(grip, { setPointerCapture: capture });
    fireEvent.pointerDown(grip, { clientX: 100, pointerId: 7 });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerUp(grip, { pointerId: 7 });
    fireEvent.pointerMove(grip, { clientX: 140, pointerId: 7 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(grip, { clientX: 100, pointerId: 7 });
    fireEvent.pointerCancel(grip, { pointerId: 7 });
    fireEvent.pointerMove(grip, { clientX: 140, pointerId: 7 });
    expect(onChange).not.toHaveBeenCalled();
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

  it("ignores movement when no drag started", () => {
    const { onChange } = setup();
    fireEvent.pointerMove(screen.getByText("Gain"), {
      clientX: 140,
      pointerId: 1,
    });
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
