import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import { GuestReview, type GuestReviewProps } from "./GuestReview";
import { DURATION, PEAKS, WORD_STARTS } from "./guestFixture";

function setup(props: Partial<GuestReviewProps> = {}) {
  return render(
    <GuestReview
      access="commenter"
      title="Field Notes 14"
      version="Rough cut"
      turns={SCRIPT_TURNS}
      wordStarts={WORD_STARTS}
      duration={DURATION}
      peaks={PEAKS}
      initialPlayhead={735}
      {...props}
    />,
  );
}

describe("GuestReview", () => {
  it("shows the composer slot to a commenter and hides it from a viewer", () => {
    const { unmount } = setup({ composer: <p>Composer here</p> });
    expect(screen.getByText("Composer here")).toBeInTheDocument();
    unmount();
    setup({ access: "viewer", composer: <p>Composer here</p> });
    expect(screen.queryByText("Composer here")).toBeNull();
  });

  it("follows the playhead in the Script", () => {
    setup({ initialPlayhead: 724 });
    expect(document.querySelector("[data-playing]")).not.toBeNull();
  });

  it("gives a viewer no composer and no Stage bar", () => {
    setup({ access: "viewer" });
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("gives an editor Edit and Review", async () => {
    setup({ access: "editor" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await userEvent.click(screen.getByRole("tab", { name: /Edit/ }));
    expect(screen.getByText("Edit opens here")).toBeInTheDocument();
  });

  it("shows a Cover with no button for a dead link", () => {
    setup({ state: "bad-link" });
    expect(
      screen.getByRole("heading", { name: "This link doesn't open anything" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Comment and collapse controls", () => {
  it.each([
    ["viewer", "desktop", false],
    ["viewer", "phone", false],
    ["commenter", "desktop", true],
    ["commenter", "phone", true],
    ["editor", "desktop", true],
    ["editor", "phone", true],
  ] as const)("%s on %s has a Comment button: %s", (access, layout, has) => {
    setup({ access, layout, onComment: () => {} });
    expect(!!screen.queryByRole("button", { name: "Comment" })).toBe(has);
  });

  it("collapses the Player only on a phone", () => {
    const { unmount } = setup({ layout: "desktop" });
    expect(
      screen.queryByRole("button", { name: "Collapse player" }),
    ).toBeNull();
    unmount();
    setup({ layout: "phone" });
    expect(
      screen.getByRole("button", { name: "Collapse player" }),
    ).toBeInTheDocument();
  });
});

describe("Back to playhead", () => {
  it("scrolls the playing word into view as well as following again", async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    setup({ initialPlayhead: 735 });
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    expect(
      screen.getByRole("button", { name: /Back to playhead/ }),
    ).toBeInTheDocument();
    scroll.mockClear();
    await userEvent.click(
      screen.getByRole("button", { name: /Back to playhead/ }),
    );
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
  });
});

describe("Role hint", () => {
  it("shows once on a first visit and tells the app when dismissed", async () => {
    const seen = vi.fn();
    setup({ firstVisit: true, onRoleHintSeen: seen });
    expect(screen.getByRole("note")).toHaveTextContent("The host decides");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(seen).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus after the hint closes", async () => {
    setup({ firstVisit: true });
    screen.getByRole("button", { name: "Dismiss hint" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("stays quiet on a later visit", () => {
    setup();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
