import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppHeader, type AppHeaderProps } from "./AppHeader";
import { ROLES } from "./linkRoles";

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
    again({
      guest: {
        version: "v3",
        role: "commenter",
        hint: { ...hint, shown: false },
      },
    });
    expect(screen.queryByRole("note")).toBeNull();
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
