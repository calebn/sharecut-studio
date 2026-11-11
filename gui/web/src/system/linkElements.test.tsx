import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LinkRow } from "./LinkRow";
import { middleTruncate } from "./linkText";
import { RoleChip } from "./RoleChip";

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
  it("names its link for assistive technology when a page has several rows", () => {
    render(
      <LinkRow
        access="editor"
        link={LINK}
        linkName="Editor link"
        copyState="copied"
        onCopy={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Copied Editor link" }),
    ).toBeInTheDocument();
  });

  it("waits to copy with the reason, and says what is missing in place of a link", () => {
    render(
      <LinkRow
        access="viewer"
        link={null}
        placeholder="No address yet."
        disabledReason="This link has no address to copy yet."
        onCopy={() => {}}
      />,
    );
    expect(screen.getByText("No address yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy" })).toHaveAttribute(
      "title",
      "This link has no address to copy yet.",
    );
  });

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

describe("LinkRow reach glyph", () => {
  const LINK = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";

  it("shows no glyph, and no paragraph about the network, without a reach", () => {
    const { container } = render(
      <LinkRow access="viewer" link={LINK} onCopy={() => {}} />,
    );
    expect(container.querySelector(".sys-link-reach")).toBeNull();
    expect(screen.queryByText(/Only people on this network/)).toBeNull();
  });

  it("shows a slashed globe for a link only this network reaches, with its sentence in a popover that Escape closes", async () => {
    const user = userEvent.setup();
    render(
      <LinkRow access="viewer" link={LINK} reach="network" onCopy={() => {}} />,
    );
    expect(screen.queryByText(/Only people on this network/)).toBeNull();
    const glyph = screen.getByRole("button", { name: "Only on this network" });
    expect(glyph.querySelector("svg")).toHaveClass("lucide-globe-off");
    await user.click(glyph);
    expect(glyph).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(
        "Only people on this network can open it. Turn on online sharing to reach anyone.",
      ),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(glyph).toHaveAttribute("aria-expanded", "false");
    expect(glyph).toHaveFocus();
  });

  it("shows a filled globe for a link that reaches anyone, and closes on an outside press", async () => {
    const user = userEvent.setup();
    render(
      <>
        <LinkRow
          access="viewer"
          link={LINK}
          reach="anywhere"
          onCopy={() => {}}
        />
        <button type="button">elsewhere</button>
      </>,
    );
    const glyph = screen.getByRole("button", {
      name: "Reachable from anywhere",
    });
    expect(glyph.querySelector("svg")).toHaveClass("lucide-globe");
    await user.click(glyph);
    expect(screen.getByText(/from anywhere/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(glyph).toHaveAttribute("aria-expanded", "false");
  });

  it("shows no glyph before the link is made, or when there is no mix", () => {
    const { rerender } = render(
      <LinkRow access="viewer" link={null} reach="network" onCopy={() => {}} />,
    );
    expect(
      screen.queryByRole("button", { name: /network|anywhere/ }),
    ).toBeNull();
    rerender(
      <LinkRow
        access="viewer"
        link={null}
        reach="network"
        noMix={{ onRefresh: () => {} }}
        onCopy={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /network|anywhere/ }),
    ).toBeNull();
  });
});

describe("LinkRow pin, people count, More and role", () => {
  const LINK = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";

  it("toggles the pin and reports the new state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LinkRow
        access="commenter"
        link={null}
        pin={{ pressed: false, onChange }}
        onCopy={() => {}}
      />,
    );
    const pin = screen.getByRole("button", { name: "Pin to this version" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await user.click(pin);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows a pin it cannot change as pressed, disabled, with the reason", () => {
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        pin={{ pressed: true, disabledReason: "Pinned when it was made." }}
        onCopy={() => {}}
      />,
    );
    const pin = screen.getByRole("button", { name: "Pin to this version" });
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(pin).toBeDisabled();
    expect(pin).toHaveAttribute("title", "Pinned when it was made.");
  });

  it("counts the people who opened it, from the avatars or a given number", () => {
    const { rerender } = render(
      <LinkRow
        access="viewer"
        link={LINK}
        openedBy={[{ name: "Rosa" }, { name: "Jon" }]}
        onCopy={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Opened by Rosa, Jon" }),
    ).toBeVisible();
    expect(screen.getByTestId("link-opened-count")).toHaveTextContent("2");
    rerender(
      <LinkRow access="viewer" link={LINK} openedCount={5} onCopy={() => {}} />,
    );
    expect(
      screen.getByRole("img", { name: "Opened by 5 people" }),
    ).toHaveTextContent("5");
    rerender(
      <LinkRow access="viewer" link={LINK} openedCount={1} onCopy={() => {}} />,
    );
    expect(
      screen.getByRole("img", { name: "Opened by 1 person" }),
    ).toBeVisible();
  });

  it("opens a More menu of what the row can do, closes it on a pick and runs the pick", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <LinkRow
        access="viewer"
        link={LINK}
        linkName="Viewer link"
        more={[
          {
            id: "mcp",
            label: "Allow AI assistants",
            checked: true,
            onSelect: () => {},
          },
          { id: "stop", label: "Stop sharing", onSelect },
          {
            id: "qr",
            label: "Locked",
            disabledReason: "Not yet.",
            onSelect: () => {},
          },
        ]}
        onCopy={() => {}}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "More for Viewer link" }),
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Allow AI assistants" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitem", { name: "Stop sharing" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("has no More button without items", () => {
    render(<LinkRow access="viewer" link={LINK} onCopy={() => {}} />);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("replaces the role chip with a segmented choice while the link is not made", async () => {
    const user = userEvent.setup();
    const onRole = vi.fn();
    const { rerender } = render(
      <LinkRow
        access="commenter"
        link={null}
        onRole={onRole}
        onCopy={() => {}}
      />,
    );
    const group = screen.getByRole("group", { name: "Who can open it" });
    expect(
      within(group).getByRole("button", { name: "Commenter: can comment" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(
      within(group).getByRole("button", { name: "Editor: can edit" }),
    );
    expect(onRole).toHaveBeenCalledWith("editor");
    rerender(
      <LinkRow
        access="commenter"
        link={LINK}
        onRole={onRole}
        onCopy={() => {}}
      />,
    );
    expect(screen.queryByRole("group", { name: "Who can open it" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "Commenter: can comment" }),
    ).toBeVisible();
  });

  it("shows a confirm in place and puts focus back on More when it goes", async () => {
    const { rerender } = render(
      <LinkRow
        access="viewer"
        link={LINK}
        linkName="Viewer link"
        more={[{ id: "stop", label: "Stop sharing", onSelect: () => {} }]}
        confirming={<p>Stop sharing this link?</p>}
        onCopy={() => {}}
      />,
    );
    expect(screen.getByText("Stop sharing this link?")).toBeVisible();
    rerender(
      <LinkRow
        access="viewer"
        link={LINK}
        linkName="Viewer link"
        more={[{ id: "stop", label: "Stop sharing", onSelect: () => {} }]}
        onCopy={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "More for Viewer link" }),
    ).toHaveFocus();
  });
});
