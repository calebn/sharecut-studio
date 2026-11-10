import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ScriptDivider } from "../stage/edit/ScriptDivider";
import { expectNoA11yViolations } from "../test/a11y";
import { AppHeader, type AppHeaderProps } from "./AppHeader";
import { ROLES } from "./linkRoles";
import { ScrubField } from "./ScrubField";

const SAVE = { state: "saved" } as const;

function setup(props: Partial<AppHeaderProps> = {}) {
  const view = render(<AppHeader title="Episode 14" save={SAVE} {...props} />);
  const again = (next: Partial<AppHeaderProps>) =>
    view.rerender(<AppHeader title="Episode 14" save={SAVE} {...next} />);
  return { ...view, again };
}

const EDIT_CONTROLS = ["Undo", "Redo", "Invite"];
// Invite is the host's alone: even a link that can edit does not get it.
const GUEST_EDIT_CONTROLS = ["Undo", "Redo"];
const EDITORS = ROLES.filter((role) => role.id === "editor");
const READERS = ROLES.filter((role) => role.id !== "editor");

describe("AppHeader as a guest", () => {
  it.each(ROLES)(
    "$id: Role chip, version and no project menu",
    ({ id, label }) => {
      setup({ guest: { version: "Rough cut", role: id } });
      expect(
        screen.getByRole("img", { name: new RegExp(`^${label}: `) }),
      ).toBeInTheDocument();
      expect(screen.getByText("Rough cut")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Project menu" })).toBeNull();
    },
  );

  it.each(EDITORS)("an $id has Undo and Redo but no Invite", ({ id }) => {
    setup({ guest: { version: "v3", role: id } });
    for (const name of GUEST_EDIT_CONTROLS) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  });

  it.each(READERS)("a $id has none of the edit controls", ({ id }) => {
    setup({ guest: { version: "v3", role: id } });
    for (const name of EDIT_CONTROLS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it.each(ROLES)("a $id keeps the palette", ({ id }) => {
    setup({ guest: { version: "v3", role: id } });
    expect(screen.getByRole("button", { name: "Palette" })).toBeInTheDocument();
  });

  it.each(ROLES)(
    "a $id can change the theme without a Project menu",
    async ({ id }) => {
      const onChange = vi.fn();
      setup({
        guest: { version: "v3", role: id },
        appearance: { value: "system", onChange },
      });
      await userEvent.click(screen.getByRole("button", { name: "Appearance" }));
      await userEvent.click(
        screen.getByRole("menuitemradio", { name: "Dark" }),
      );
      expect(onChange).toHaveBeenCalledWith("dark");
      expect(screen.queryByRole("button", { name: "Project menu" })).toBeNull();
    },
  );

  it("keeps the theme in the Stage menu when the header is compact", async () => {
    const onChange = vi.fn();
    setup({
      compact: true,
      guest: { version: "v3", role: "viewer" },
      appearance: { value: "system", onChange },
    });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("lists the version with its glyph and offers Listen on a new one", async () => {
    const onListen = vi.fn();
    setup({
      guest: {
        version: "Rough cut",
        followsLatest: true,
        role: "commenter",
        update: { id: "v2", label: "Intro fix", onListen },
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: /New version: Intro fix/ }),
    );
    expect(onListen).toHaveBeenCalledOnce();
  });

  it("is the host, with the edit controls, when it is not a guest", () => {
    setup();
    for (const name of EDIT_CONTROLS) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it.each([
    ["compact", true, ""],
    ["full", false, "Commenter"],
  ])("the Role chip is %s", (_name, compact, text) => {
    setup({ guest: { version: "v3", role: "commenter", compact } });
    expect(screen.getByRole("img", { name: /^Commenter: / }).textContent).toBe(
      text,
    );
  });

  it("shows the hint once and dismisses it", async () => {
    const onDismiss = vi.fn();
    const hint = { text: "You can comment.", shown: true, onDismiss };
    const { again } = setup({
      guest: { version: "v3", role: "commenter", hint },
    });
    expect(screen.getAllByRole("note")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Explain Commenter role" }),
    ).toHaveFocus();
    again({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { ...hint, shown: false },
      },
    });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("reopens a dismissed role explanation from its role control", async () => {
    const onDismiss = vi.fn();
    const hint = { text: "You can comment.", shown: true, onDismiss };
    const { again } = setup({
      guest: { version: "v3", role: "commenter", hint },
    });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    again({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { ...hint, shown: false },
      },
    });

    const trigger = screen.getByRole("button", {
      name: "Explain Commenter role",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("You can comment.");
    expect(screen.getByText("You can comment.")).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", dialog.id);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Explain Commenter role" }),
    ).toHaveFocus();
  });

  it("keeps the first-visit tip passive and does not reopen it on the dismissing activation", async () => {
    const onDismiss = vi.fn();
    setup({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { text: "You can comment.", shown: true, onDismiss },
      },
    });
    const trigger = screen.getByRole("button", {
      name: "Explain Commenter role",
    });
    expect(screen.getByRole("note")).toBeVisible();
    expect(trigger).not.toHaveFocus();

    await userEvent.click(trigger);

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it.each([
    ["pointer", async (trigger: HTMLElement) => userEvent.click(trigger)],
    [
      "Enter",
      async (trigger: HTMLElement) => {
        trigger.focus();
        await userEvent.keyboard("{Enter}");
      },
    ],
    [
      "Space",
      async (trigger: HTMLElement) => {
        trigger.focus();
        await userEvent.keyboard(" ");
      },
    ],
  ])(
    "does not rebound into a manual dialog on first %s activation when parent dismissal updates eligibility",
    async (_input, activate) => {
      function ControlledHeader() {
        const [shown, setShown] = useState(true);
        return (
          <AppHeader
            title="Episode"
            guest={{
              version: "v3",
              role: "commenter",
              hint: {
                text: "You can comment.",
                shown,
                onDismiss: () => setShown(false),
              },
            }}
          />
        );
      }

      render(<ControlledHeader />);
      const trigger = screen.getByRole("button", {
        name: "Explain Commenter role",
      });
      await activate(trigger);

      expect(screen.queryByRole("note")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("opens the manual explanation with %s", async (_name, key) => {
    const user = userEvent.setup();
    setup({
      guest: {
        version: "v3",
        role: "commenter",
        hint: {
          text: "You can comment.",
          shown: false,
          onDismiss: vi.fn(),
        },
      },
    });
    const trigger = screen.getByRole("button", {
      name: "Explain Commenter role",
    });
    trigger.focus();

    await user.keyboard(key);

    expect(screen.getByRole("dialog")).toHaveTextContent("You can comment.");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("dismisses an automatic tip outside without stealing focus", async () => {
    const onDismiss = vi.fn();
    const onOutsideClick = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <button type="button" onClick={onOutsideClick}>
          Outside
        </button>
        <AppHeader
          title="Episode"
          guest={{
            version: "v3",
            role: "commenter",
            hint: { text: "You can comment.", shown: true, onDismiss },
          }}
        />
      </>,
    );
    const outside = screen.getByRole("button", { name: "Outside" });

    await user.click(outside);

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOutsideClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("note")).toBeNull();
    expect(outside).toHaveFocus();
  });

  it("keeps a manual explanation open across eligibility changes", async () => {
    const hint = {
      text: "You can comment.",
      shown: false,
      onDismiss: vi.fn(),
    };
    const { again } = setup({
      guest: { version: "v3", role: "commenter", hint },
    });
    const trigger = screen.getByRole("button", {
      name: "Explain Commenter role",
    });
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();

    again({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { ...hint, shown: true },
      },
    });
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("does not revive an automatic hint when eligibility returns", async () => {
    const hint = { text: "You can comment.", shown: true, onDismiss: vi.fn() };
    const { again } = setup({
      guest: { version: "v3", role: "commenter", hint },
    });
    expect(screen.getByRole("note")).toBeVisible();

    again({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { ...hint, shown: false },
      },
    });
    expect(screen.queryByRole("note")).toBeNull();
    again({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { ...hint, shown: true },
      },
    });

    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Explain Commenter role" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("You can comment.");
  });

  it("closes a manual explanation outside and leaves focus on the outside target", async () => {
    const user = userEvent.setup();
    const onOutsideClick = vi.fn();
    render(
      <>
        <button type="button" onClick={onOutsideClick}>
          Outside
        </button>
        <AppHeader
          title="Episode"
          guest={{
            version: "v3",
            role: "commenter",
            hint: {
              text: "You can comment.",
              shown: false,
              onDismiss: vi.fn(),
            },
          }}
        />
      </>,
    );
    const trigger = screen.getByRole("button", {
      name: "Explain Commenter role",
    });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();

    const outside = screen.getByRole("button", { name: "Outside" });
    await user.click(outside);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOutsideClick).toHaveBeenCalledOnce();
    expect(outside).toHaveFocus();
  });

  it.each([true, false])(
    "dismisses outside capture interception (automatic %s)",
    async (automatic) => {
      const user = userEvent.setup();
      const clicked = vi.fn();
      render(
        <>
          <AppHeader
            title="Episode"
            guest={{
              version: "v3",
              role: "editor",
              hint: {
                text: "You can edit.",
                shown: automatic,
                onDismiss: vi.fn(),
              },
            }}
          />
          <button
            type="button"
            onPointerDownCapture={(e) => e.stopPropagation()}
            onClick={clicked}
          >
            Routed outside surface
          </button>
        </>,
      );
      if (!automatic)
        await user.click(
          screen.getByRole("button", { name: "Explain Editor role" }),
        );
      expect(screen.getByRole(automatic ? "note" : "dialog")).toBeVisible();
      await user.click(
        screen.getByRole("button", { name: "Routed outside surface" }),
      );
      expect(clicked).toHaveBeenCalledOnce();
      expect(screen.queryByRole("note")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("keeps the real Script divider focused after dismissing a manual explanation", async () => {
    const user = userEvent.setup();
    const onResize = vi.fn();
    render(
      <>
        <AppHeader
          title="Episode"
          guest={{
            version: "v3",
            role: "editor",
            hint: { text: "You can edit.", shown: false, onDismiss: vi.fn() },
          }}
        />
        <ScriptDivider widthRem={25} onResize={onResize} onReset={vi.fn()} />
      </>,
    );
    await user.click(
      screen.getByRole("button", { name: "Explain Editor role" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    const divider = screen.getByRole("separator", { name: "Resize Script" });
    const down = createEvent.pointerDown(divider, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
    });
    fireEvent(divider, down);
    expect(down.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(divider).toHaveFocus();
    const arrow = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    fireEvent(divider, arrow);
    expect(arrow.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(24);
  });

  it("does not commit a focused ScrubField draft when its pointer dismisses the explanation", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <>
        <AppHeader
          title="Episode"
          guest={{
            version: "v3",
            role: "editor",
            hint: { text: "You can edit.", shown: false, onDismiss: vi.fn() },
          }}
        />
        <ScrubField label="Outside value" value={1} onCommit={onCommit} />
      </>,
    );
    await user.click(
      screen.getByRole("button", { name: "Explain Editor role" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
    );
    const field = screen.getByRole("spinbutton", { name: "Outside value" });
    for (let n = 0; n < 24 && document.activeElement !== field; n++)
      await user.tab();
    expect(field).toHaveFocus();
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Outside value" });
    await user.clear(input);
    await user.keyboard("12");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onCommit).not.toHaveBeenCalled();
    await user.click(input);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Outside value" })).toHaveValue(
      "12",
    );
    expect(input).toHaveFocus();
  });

  it("returns focus to the role button after Close activation from outside focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AppHeader
          title="Episode"
          guest={{
            version: "v3",
            role: "commenter",
            hint: {
              text: "You can comment.",
              shown: false,
              onDismiss: vi.fn(),
            },
          }}
        />
        <button type="button">Outside action</button>
      </>,
    );
    const trigger = screen.getByRole("button", {
      name: "Explain Commenter role",
    });
    await user.click(trigger);
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    const outside = screen.getByRole("button", { name: "Outside action" });
    for (let n = 0; n < 24 && document.activeElement !== outside; n++)
      await user.tab();
    expect(outside).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the role button when the manual explanation closes", async () => {
    setup({
      guest: {
        version: "v3",
        role: "commenter",
        hint: {
          text: "You can comment.",
          shown: false,
          onDismiss: vi.fn(),
        },
      },
    });
    const trigger = screen.getByRole("button", {
      name: "Explain Commenter role",
    });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it.each(["Close", "Escape"])(
    "returns focus to the role button after manual %s even when another control held focus",
    async (dismiss) => {
      render(
        <>
          <button type="button">Previously focused</button>
          <AppHeader
            title="Episode"
            guest={{
              version: "v3",
              role: "commenter",
              hint: {
                text: "You can comment.",
                shown: false,
                onDismiss: vi.fn(),
              },
            }}
          />
        </>,
      );
      const previous = screen.getByRole("button", {
        name: "Previously focused",
      });
      previous.focus();
      const trigger = screen.getByRole("button", {
        name: "Explain Commenter role",
      });
      fireEvent.click(trigger);
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(trigger).toHaveFocus();

      if (dismiss === "Close") {
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
      } else {
        fireEvent.keyDown(window, { key: "Escape" });
      }
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(trigger).toHaveFocus();
    },
  );

  it("starts a fresh hint lifetime when the guest role changes", () => {
    const hint = { text: "Role details.", shown: true, onDismiss: vi.fn() };
    const { again } = setup({
      guest: { version: "v3", role: "commenter", hint },
    });
    expect(screen.getByRole("note")).toBeVisible();

    again({
      guest: {
        version: "v3",
        role: "viewer",
        hint: { ...hint, shown: false },
      },
    });
    expect(screen.queryByRole("note")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Explain Viewer role" }),
    ).toBeInTheDocument();

    again({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { ...hint, shown: true },
      },
    });
    expect(screen.getByRole("note")).toBeVisible();
  });
});

describe("AppHeader Project menu", () => {
  it("keeps Invite, search and the People rows reachable when the header's right side gives way", async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();
    const onPalette = vi.fn();
    render(
      <AppHeader
        title="Episode"
        onInvite={onInvite}
        onPalette={onPalette}
        menuPeople={<div role="menuitem">Maya · Follow</div>}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Episode/ }));
    expect(
      screen.getByRole("menuitem", { name: "Maya · Follow" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Invite" }));
    expect(onInvite).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /Episode/ }));
    await user.click(
      screen.getByRole("menuitem", { name: "Search commands and people" }),
    );
    expect(onPalette).toHaveBeenCalledTimes(1);
  });

  it("ends with Settings, Connect agent and Help, each reported by its row id", async () => {
    const user = userEvent.setup();
    const onMenuCommand = vi.fn();
    render(<AppHeader title="Episode" onMenuCommand={onMenuCommand} />);
    const trigger = screen.getByRole("button", { name: /Episode/ });
    expect(trigger).toHaveAttribute("data-app-menu");
    await user.click(trigger);
    const rows = screen.getAllByRole("menuitem").map((row) => row.textContent);
    expect(rows.slice(-3)).toEqual(["Settings", "Connect agent", "Help"]);
    for (const [name, command] of [
      ["Settings", "settings"],
      ["Connect agent", "agent"],
      ["Help", "help"],
    ]) {
      await user.click(screen.getByRole("menuitem", { name }));
      expect(onMenuCommand).toHaveBeenLastCalledWith(command);
      await user.click(trigger);
    }
  });

  it("has no Project menu on a shared link", () => {
    render(
      <AppHeader
        title="Episode"
        guest={{ version: "Shared link", role: "viewer" }}
        onInvite={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /Episode/ })).toBeNull();
  });

  it("gives a link that is not the host no Invite, whatever its role", async () => {
    const user = userEvent.setup();
    for (const role of ["editor", "commenter", "viewer"] as const) {
      const { unmount } = render(
        <AppHeader
          title="Episode"
          guest={{ version: "Shared link", role }}
          onInvite={() => undefined}
          onPalette={() => undefined}
          compact
        />,
      );
      expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "More" }));
      expect(screen.queryByRole("menuitem", { name: "Invite" })).toBeNull();
      unmount();
    }
    render(<AppHeader title="Episode" onInvite={() => undefined} />);
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
  });
});

describe("AppHeader Stage menu", () => {
  const stages = {
    active: "review",
    stages: ["edit", "review"],
    onSelect: () => undefined,
  } as const;

  it.each(["editor", "commenter", "viewer"] as const)(
    "keeps Follow and search reachable for a %s link while the right side gives way",
    async (role) => {
      const user = userEvent.setup();
      const onPalette = vi.fn();
      render(
        <AppHeader
          title="Episode"
          guest={{ version: "Shared link", role }}
          stages={role === "viewer" ? undefined : stages}
          onPalette={onPalette}
          menuPeople={<div role="menuitem">Maya · Follow</div>}
          compact
        />,
      );
      expect(screen.queryByRole("button", { name: /Palette/ })).toBeNull();
      await user.click(
        screen.getByRole("button", {
          name: role === "viewer" ? "More" : "Stage menu, Review",
        }),
      );
      expect(
        screen.getByRole("menuitem", { name: "Maya · Follow" }),
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole("menuitem", { name: "Search commands and people" }),
      );
      expect(onPalette).toHaveBeenCalledTimes(1);
    },
  );

  it("lists Invite for the host after the stages", async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();
    render(
      <AppHeader title="Episode" stages={stages} onInvite={onInvite} compact />,
    );
    await user.click(
      screen.getByRole("button", { name: "Stage menu, Review" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Invite" }));
    expect(onInvite).toHaveBeenCalledTimes(1);
  });

  it("holds only the right side's controls where the Stage bar stays in the header", async () => {
    const user = userEvent.setup();
    render(
      <AppHeader
        title="Episode"
        stages={stages}
        onPalette={() => undefined}
        stagesInMenu={false}
        compact
      />,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(
      screen.queryByRole("menuitem", { name: /Review/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Search commands and people" }),
    ).toBeInTheDocument();
  });

  it("shows the right side, and no More menu, while the header has room", () => {
    render(<AppHeader title="Episode" onPalette={() => undefined} />);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getByRole("button", { name: /Palette/ })).toBeInTheDocument();
  });
});

describe("AppHeader rename", () => {
  async function openRename() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Episode 14/ }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Rename project" }),
    );
    const field = await screen.findByRole("textbox", { name: "Project name" });
    await waitFor(() => expect(field).toHaveFocus());
    return { user, field };
  }

  it("offers no Rename row without onRename", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Episode 14/ }));
    expect(
      screen.queryByRole("menuitem", { name: "Rename project" }),
    ).toBeNull();
  });

  it("opens a card with the name selected, outside the menu", async () => {
    setup({ onRename: vi.fn() });
    const { field } = await openRename();
    expect(field).toHaveValue("Episode 14");
    expect(field).toHaveFocus();
    expect(field.closest('[role="menu"]')).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("applies the trimmed name on Enter and returns focus to the Project button", async () => {
    const onRename = vi.fn();
    setup({ onRename });
    const { user, field } = await openRename();
    await user.clear(field);
    await user.type(field, "  Finale  {Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Finale");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Episode 14/ })).toHaveFocus(),
    );
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
  });

  it("cancels on Escape and does not commit on blur", async () => {
    const onRename = vi.fn();
    setup({ onRename });
    const first = await openRename();
    await first.user.type(first.field, " changed");
    await first.user.tab();
    expect(onRename).not.toHaveBeenCalled();
    await first.user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Episode 14/ })).toHaveFocus();
  });

  it("returns focus to the Project button after a press outside", async () => {
    const onRename = vi.fn();
    setup({ onRename });
    const { user } = await openRename();
    await user.click(document.body);
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Project name" }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Episode 14/ })).toHaveFocus(),
    );
    expect(onRename).not.toHaveBeenCalled();
  });

  it("closes on Cancel without renaming and returns focus to the Project button", async () => {
    const onRename = vi.fn();
    setup({ onRename });
    const { user, field } = await openRename();
    await user.type(field, "x");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Episode 14/ })).toHaveFocus(),
    );
  });

  it("does not call onRename for an unchanged name", async () => {
    const onRename = vi.fn();
    setup({ onRename });
    const { user } = await openRename();
    await user.keyboard("{Enter}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
  });

  it("refuses an empty name inline and keeps the card open", async () => {
    const onRename = vi.fn();
    setup({ onRename });
    const { user, field } = await openRename();
    await user.clear(field);
    await user.keyboard("{Enter}");
    expect(onRename).not.toHaveBeenCalled();
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription("Enter a project name.");
    await user.type(field, "a");
    expect(field).toBeValid();
  });

  it("shows the reason when the rename is refused and keeps the typing", async () => {
    const onRename = vi.fn().mockRejectedValue(new Error("Nope, too long."));
    setup({ onRename });
    const { user, field } = await openRename();
    await user.type(field, "!{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nope, too long.",
    );
    expect(field).toHaveValue("Episode 14!");
    expect(field).toHaveAccessibleDescription("Nope, too long.");
    expect(field).toHaveFocus();
  });
});

describe("AppHeader undo hint", () => {
  const HINT = {
    text: "Two-finger tap to undo",
    shown: true,
    onDismiss: vi.fn(),
  };

  it("undoes once and dismisses when Undo is pressed", async () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    setup({ onUndo, undoHint: { ...HINT, onDismiss } });
    expect(screen.getByRole("note")).toHaveTextContent(HINT.text);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations while shown", async () => {
    const { container } = setup({ undoHint: HINT });
    await expectNoA11yViolations(container);
  });
});
