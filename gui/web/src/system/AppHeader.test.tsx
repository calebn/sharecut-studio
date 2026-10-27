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
});
