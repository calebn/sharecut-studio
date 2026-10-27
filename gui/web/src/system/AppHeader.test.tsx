import { render, screen } from "@testing-library/react";
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

  it.each(EDITORS)("an $id has the edit controls", ({ id }) => {
    setup({ guest: { version: "v3", role: id } });
    for (const name of EDIT_CONTROLS) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
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
