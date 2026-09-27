import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { sessionClient } from "../test/fixtures";
import { AvatarStackView } from "./AvatarStackView";

const NAMES = new Map([
  ["me", "Me"],
  ["a", "Ada"],
  ["b", "Bo"],
  ["c", "Cy"],
  ["d", "Di"],
]);

describe("AvatarStackView", () => {
  it("shows three avatars plus overflow and the following-you badge", async () => {
    const self = sessionClient({ client_id: "me", followers: 2 });
    const others = [
      sessionClient({ client_id: "a" }),
      sessionClient({ client_id: "b" }),
      sessionClient({ client_id: "c" }),
      sessionClient({ client_id: "d" }),
    ];
    const { container } = render(
      <AvatarStackView
        others={others}
        self={self}
        names={NAMES}
        followingClientId={null}
        onFollow={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Follow Ada" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+1 more" })).toBeTruthy();
    expect(screen.getByLabelText("2 following you")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("follows from the overflow menu", async () => {
    const onFollow = vi.fn();
    render(
      <AvatarStackView
        others={[
          sessionClient({ client_id: "a" }),
          sessionClient({ client_id: "b" }),
          sessionClient({ client_id: "c" }),
          sessionClient({ client_id: "d" }),
        ]}
        names={NAMES}
        followingClientId={null}
        onFollow={onFollow}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "+1 more" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Di/ }));
    expect(onFollow).toHaveBeenCalledWith("d");
  });

  it("names the follow control Stop following when pressed", () => {
    render(
      <AvatarStackView
        others={[sessionClient({ client_id: "a" })]}
        names={NAMES}
        followingClientId="a"
        onFollow={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Stop following Ada" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Stop following Ada" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("renders nothing when the roster is empty", () => {
    const { container } = render(
      <AvatarStackView
        others={[]}
        names={NAMES}
        followingClientId={null}
        onFollow={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists people in the menu variant, or renders nothing when no one is there", () => {
    const { rerender, container } = render(
      <div role="menu" aria-label="People">
        <AvatarStackView
          variant="menu"
          others={[sessionClient({ client_id: "a" })]}
          names={NAMES}
          followingClientId={null}
          onFollow={vi.fn()}
        />
      </div>,
    );
    expect(screen.getByRole("group", { name: "People" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Ada/ })).toBeTruthy();

    rerender(
      <div role="menu" aria-label="People">
        <AvatarStackView
          variant="menu"
          others={[]}
          names={NAMES}
          followingClientId={null}
          onFollow={vi.fn()}
        />
      </div>,
    );
    expect(container.querySelector(".ui-menu-section")).toBeNull();
  });
});
