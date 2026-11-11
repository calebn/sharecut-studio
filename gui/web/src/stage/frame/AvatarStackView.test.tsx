import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { sessionClient } from "../../test/fixtures";
import type { PresenceUi } from "../../types/session";
import { AvatarStackView } from "./AvatarStackView";
import type { PresenceViewer } from "./personCard";

const NAMES = new Map([
  ["me", "Me"],
  ["a", "Ada"],
  ["b", "Bo"],
  ["c", "Cy"],
  ["d", "Di"],
]);

const VIEWER: PresenceViewer = {
  stage: "edit",
  durationSec: 3600,
  caps: { guestShare: false, breakpoint: "desktop", role: "host" },
};

function peer(
  client_id: string,
  ui: PresenceUi | null = null,
  playhead?: number,
) {
  return sessionClient({
    client_id,
    meta: {
      color_index: 1,
      ui,
      ...(playhead === undefined
        ? {}
        : { transport: { playhead_sec: playhead, playing: false, rate: 1 } }),
    },
  });
}

function stack(
  props: Partial<React.ComponentProps<typeof AvatarStackView>> = {},
) {
  const onFollow = vi.fn();
  const onUnfollow = vi.fn();
  const onGoTo = vi.fn();
  const view = render(
    <AvatarStackView
      others={[peer("a", { tab: "impact" }, 874)]}
      names={NAMES}
      followingClientId={null}
      viewer={VIEWER}
      onFollow={onFollow}
      onUnfollow={onUnfollow}
      onGoTo={onGoTo}
      {...props}
    />,
  );
  return { ...view, onFollow, onUnfollow, onGoTo };
}

describe("AvatarStackView header", () => {
  it("renders nothing when alone", () => {
    const { container } = stack({ others: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("names a face with where the person is", () => {
    stack();
    const face = screen.getByRole("button", { name: "Ada, Review, 14:34" });
    expect(face).toHaveAttribute("aria-haspopup", "menu");
    expect(face.querySelector(".sys-person-avatar--24")).not.toBeNull();
    expect(face.textContent).toBe("");
  });

  it("badges a person in another stage and not one in the viewer's", () => {
    stack({
      others: [peer("a", { tab: "impact" }), peer("b", { tab: "transcript" })],
    });
    expect(
      screen
        .getByRole("button", { name: /^Ada/ })
        .querySelector(".avatar-face-badge"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: /^Bo/ })
        .querySelector(".avatar-face-badge"),
    ).toBeNull();
  });

  it("shows three faces, then a count for the rest, and who follows you", async () => {
    const { container } = stack({
      others: ["a", "b", "c", "d"].map((id) => peer(id)),
      self: sessionClient({ client_id: "me", followers: 2 }),
    });
    expect(container.querySelectorAll(".avatar-face")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "+1 more" })).toBeTruthy();
    expect(screen.getByLabelText("2 following you")).toBeTruthy();
    await expectNoA11yViolations(container, [
      { id: "label-content-name-mismatch", enabled: true },
    ]);
  });

  it("opens a menu with the person, Follow and Go to", async () => {
    const { onFollow, onGoTo } = stack();
    await userEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    const menu = screen.getByRole("menu", { name: "Ada, Review, 14:34" });
    expect(menu).toHaveTextContent("Viewer · Review · 14:34");
    await expectNoA11yViolations(menu);
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Go to where they are" }),
    );
    expect(onGoTo).toHaveBeenCalledWith("a");
    expect(onFollow).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Follow" }));
    expect(onFollow).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Stop following to the person being followed", async () => {
    const { onFollow } = stack({ followingClientId: "a" });
    await userEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Stop following" }),
    );
    expect(onFollow).toHaveBeenCalledWith("a");
  });

  it("leaves Go to out when the link cannot open where they are", async () => {
    stack({
      others: [peer("a", { tab: "pipeline" }, 12)],
      viewer: {
        ...VIEWER,
        stage: "review",
        caps: { guestShare: true, breakpoint: "desktop", role: "viewer" },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    expect(screen.getByRole("menuitem", { name: "Follow" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Go to/ })).toBeNull();
  });

  it("leaves Go to out when there is nowhere to go", async () => {
    stack({ others: [peer("a", { tab: "transcript" })] });
    await userEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    expect(screen.queryByRole("menuitem", { name: /Go to/ })).toBeNull();
  });

  it("says who a person follows instead of a time", () => {
    const rider = sessionClient({
      client_id: "b",
      meta: { color_index: 2, following: "a", ui: { tab: "impact" } },
    });
    stack({ others: [peer("a", { tab: "impact" }, 5), rider] });
    expect(
      screen.getByRole("button", { name: "Bo, Review, Following Ada" }),
    ).toBeTruthy();
  });

  it("returns focus to the face when Escape closes the menu", async () => {
    stack();
    const face = screen.getByRole("button", { name: /^Ada/ });
    await userEvent.click(face);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Follow" })).toHaveFocus(),
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(face).toHaveFocus();
  });

  it("lists the people behind the count with their own rows", async () => {
    const { onFollow } = stack({
      others: ["a", "b", "c", "d"].map((id) => peer(id)),
    });
    await userEvent.click(screen.getByRole("button", { name: "+1 more" }));
    const group = screen.getByRole("group", { name: "Di" });
    await userEvent.click(
      within(group).getByRole("menuitem", { name: "Follow" }),
    );
    expect(onFollow).toHaveBeenCalledWith("d");
  });

  it("gives the phone one face and a count of everyone else", async () => {
    stack({ others: ["a", "b", "c"].map((id) => peer(id)) });
    await userEvent.click(screen.getByRole("button", { name: "+2 more" }));
    const menu = screen.getByRole("menu", { name: "More people" });
    expect(
      within(menu).getAllByRole("menuitem", { name: "Follow" }),
    ).toHaveLength(2);
    expect(within(menu).getByRole("group", { name: "Bo" })).toBeTruthy();
  });
});

describe("AvatarStackView Following pill", () => {
  it("shows the pill and ring for the person followed, and stops on ×", async () => {
    const { onUnfollow, container } = stack({
      others: [peer("a", { tab: "impact" }, 5), peer("b")],
      followingClientId: "a",
    });
    const stop = screen.getByRole("button", { name: "Stop following Ada" });
    expect(stop.closest(".avatar-follow")).toHaveTextContent("Following Ada");
    expect(
      container.querySelectorAll(".avatar-face[data-following]"),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Ada/ })).toHaveAttribute(
      "data-following",
    );
    await userEvent.click(stop);
    expect(onUnfollow).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("is absent when nobody is followed", () => {
    const { container } = stack();
    expect(container.querySelector(".avatar-follow")).toBeNull();
  });
});

describe("AvatarStackView menu variant", () => {
  it("lists people with Follow and Go to rows, or renders nothing when no one is there", async () => {
    const onFollow = vi.fn();
    const onGoTo = vi.fn();
    const { rerender, container } = render(
      <div role="menu" aria-label="People">
        <AvatarStackView
          variant="menu"
          others={[peer("a", { tab: "impact" }, 9)]}
          names={NAMES}
          followingClientId={null}
          viewer={VIEWER}
          onFollow={onFollow}
          onGoTo={onGoTo}
        />
      </div>,
    );
    expect(screen.getByRole("group", { name: "People" })).toBeTruthy();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Ada · Follow/ }),
    );
    expect(onFollow).toHaveBeenCalledWith("a");
    await userEvent.click(screen.getByRole("menuitem", { name: "Go to Ada" }));
    expect(onGoTo).toHaveBeenCalledWith("a");

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
