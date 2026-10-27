import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

  it("shows each person who opened it by their initials", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        openedBy={[{ name: "Rosa" }, { name: "Jon" }]}
        onCopy={() => {}}
      />,
    );
    const group = screen.getByRole("img", { name: "Opened by Rosa, Jon" });
    expect(group.textContent).toBe("RJ");
  });

  it("shows a single person who opened it", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        openedBy={[{ name: "Rosa" }]}
        onCopy={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Opened by Rosa" }).textContent,
    ).toBe("R");
  });

  it("shows at most three avatars but names everyone", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        openedBy={["Ann", "Bo", "Cy", "Di", "Ed"].map((name) => ({ name }))}
        onCopy={() => {}}
      />,
    );
    const group = screen.getByRole("img", {
      name: "Opened by Ann, Bo, Cy, Di, Ed",
    });
    expect(group.textContent).toBe("ABC");
  });

  it("says which key to press, with the modifier first", () => {
    const blocked = () =>
      render(
        <LinkRow
          access="viewer"
          link={LINK}
          copyState="blocked"
          onCopy={() => {}}
        />,
      );
    const first = blocked();
    expect(
      screen.getByRole("button", { name: "Press Ctrl C" }),
    ).toBeInTheDocument();
    first.unmount();
    const platform = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      blocked();
      expect(
        screen.getByRole("button", { name: "Press ⌘ C" }),
      ).toBeInTheDocument();
    } finally {
      platform.mockRestore();
    }
  });

  it("announces the copy result politely", () => {
    render(<LinkRow access="viewer" link={LINK} onCopy={() => {}} />);
    expect(screen.getByRole("button", { name: "Copy" })).toHaveAttribute(
      "aria-live",
      "polite",
    );
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
    expect(screen.getByText("Make a mix to share")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("offers Refresh mix and no link when a link arrives with no mix", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        noMix={{ onRefresh: () => {} }}
        onCopy={() => {}}
      />,
    );
    expect(screen.getByText("Make a mix to share")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh mix" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByText(middleTruncate(LINK))).toBeNull();
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

  it("reads typed text with the parser it was given, on Enter and on blur", async () => {
    const parse = (text: string) => (text === "seven" ? 7 : null);
    const { onChange, input } = setup({ parse });
    await userEvent.clear(input);
    await userEvent.type(input, "seven{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(7);
    onChange.mockClear();
    await userEvent.clear(input);
    await userEvent.type(input, "seven");
    await userEvent.tab();
    expect(onChange).toHaveBeenLastCalledWith(7);
    onChange.mockClear();
    await userEvent.clear(input);
    await userEvent.type(input, "15");
    await userEvent.tab();
    expect(onChange).not.toHaveBeenCalled();
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

describe("TimeField dragging with a parent that applies each change", () => {
  it("follows the pointer from where the drag began instead of compounding", () => {
    function Controlled() {
      const [value, setValue] = useState(10);
      return (
        <TimeField label="Gain" value={value} step={1} onChange={setValue} />
      );
    }
    render(<Controlled />);
    const grip = screen.getByText("Gain");
    const input = screen.getByRole("textbox", { name: "Gain" });
    fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 108, pointerId: 1 });
    expect(input).toHaveValue("12");
    fireEvent.pointerMove(grip, { clientX: 116, pointerId: 1 });
    expect(input).toHaveValue("14");
    fireEvent.pointerMove(grip, { clientX: 124, pointerId: 1 });
    expect(input).toHaveValue("16");
    fireEvent.pointerMove(grip, { clientX: 100, pointerId: 1 });
    expect(input).toHaveValue("10");
  });
});

describe("middleTruncate", () => {
  const text = (n: number) => "abcdefghij".repeat(10).slice(0, n);
  it.each([0, 1, 15, 16, 28, 29])("leaves %i characters alone", (n) => {
    expect(middleTruncate(text(n))).toBe(text(n));
  });
  it.each([30, 31, 60])(
    "cuts %i characters to the first 14, a gap and the last 14",
    (n) => {
      const link = text(n);
      const cut = middleTruncate(link);
      expect(cut).toBe(`${link.slice(0, 14)}…${link.slice(-14)}`);
      expect(cut).toHaveLength(29);
    },
  );
  it("takes its own keep length", () => {
    expect(middleTruncate("abcdefghijkl", 3)).toBe("abc…jkl");
    expect(middleTruncate("abcdefg", 3)).toBe("abcdefg");
    expect(middleTruncate("abcdefgh", 3)).toBe("abc…fgh");
  });
});

describe("LinkRow reach", () => {
  const LINK = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";
  const SENTENCE =
    "Only people on this network can listen. Turn on online sharing to reach anyone.";

  it.each([
    ["network", true],
    ["anywhere", false],
    [undefined, false],
  ] as const)("reach %s says who can listen: %s", (reach, shown) => {
    const { container } = render(
      <LinkRow access="viewer" link={LINK} reach={reach} onCopy={() => {}} />,
    );
    expect(screen.queryByText(SENTENCE) !== null).toBe(shown);
    expect(container.querySelector(".sys-link-reach") !== null).toBe(shown);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("keeps the link icon beside the sentence", () => {
    const { container } = render(
      <LinkRow access="viewer" link={LINK} reach="network" onCopy={() => {}} />,
    );
    expect(container.querySelector(".sys-link-reach svg")).not.toBeNull();
  });

  it("says nothing about reach when there is no mix", () => {
    render(
      <LinkRow
        access="viewer"
        link={null}
        reach="network"
        noMix={{ onRefresh: () => {} }}
        onCopy={() => {}}
      />,
    );
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});
