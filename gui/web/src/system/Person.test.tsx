import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PersonAvatar, PersonTile } from "./Person";
import { PERSON_STATES, type PersonTileState } from "./personStates";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };

describe("PersonAvatar", () => {
  it("shows initials and hides from assistive tech when the name is printed", () => {
    const { container } = render(<PersonAvatar person={MAYA} size={28} />);
    const avatar = container.firstElementChild;
    expect(avatar).toHaveTextContent("MO");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveClass("sys-person-avatar--28");
  });

  it("names itself when it stands alone", () => {
    render(<PersonAvatar person={MAYA} decorative={false} />);
    expect(screen.getByRole("img", { name: "Maya Okafor" })).toBeVisible();
  });
});

describe("PersonTile", () => {
  it.each(
    Object.entries(PERSON_STATES) as [
      PersonTileState,
      (typeof PERSON_STATES)[PersonTileState],
    ][],
  )("says %s in plain text, and is not a button", (state, { text }) => {
    render(<PersonTile person={MAYA} state={state} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByText("Maya Okafor")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses the words the design names", () => {
    expect(Object.values(PERSON_STATES).map((entry) => entry.text)).toEqual([
      "Waiting",
      "Joined",
      "Didn't join",
      "Connection lost",
      "Weak signal",
      "Saving",
      "Saved",
    ]);
  });

  it("is a button only when empty, and invites", async () => {
    const onInvite = vi.fn();
    render(<PersonTile onInvite={onInvite} />);
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(onInvite).toHaveBeenCalledOnce();
  });
});
