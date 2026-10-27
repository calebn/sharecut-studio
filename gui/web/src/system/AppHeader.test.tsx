import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";

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
        guest={{ version: "Shared link", role: "Viewer" }}
        onInvite={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /Episode/ })).toBeNull();
  });

  it("gives a link that is not the host no Invite, whatever its role", async () => {
    const user = userEvent.setup();
    for (const role of ["Editor", "Commenter", "Viewer"] as const) {
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

  it.each(["Editor", "Commenter", "Viewer"] as const)(
    "keeps Follow and search reachable for a %s link while the right side gives way",
    async (role) => {
      const user = userEvent.setup();
      const onPalette = vi.fn();
      render(
        <AppHeader
          title="Episode"
          guest={{ version: "Shared link", role }}
          stages={role === "Viewer" ? undefined : stages}
          onPalette={onPalette}
          menuPeople={<div role="menuitem">Maya · Follow</div>}
          compact
        />,
      );
      expect(screen.queryByRole("button", { name: /Palette/ })).toBeNull();
      await user.click(
        screen.getByRole("button", {
          name: role === "Viewer" ? "More" : "Stage menu, Review",
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
