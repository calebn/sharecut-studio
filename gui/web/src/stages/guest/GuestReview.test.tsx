import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GuestReview, type GuestReviewProps } from "./GuestReview";
import { DURATION, PEAKS, SCRIPT_TURNS, WORD_STARTS } from "./guestFixture";

function setup(props: Partial<GuestReviewProps> = {}) {
  return render(
    <GuestReview
      role="commenter"
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
    setup({ role: "viewer", composer: <p>Composer here</p> });
    expect(screen.queryByText("Composer here")).toBeNull();
  });

  it("follows the playhead in the Script", () => {
    setup({ initialPlayhead: 724 });
    expect(document.querySelector("[data-playing]")).not.toBeNull();
  });

  it("gives a viewer no composer and no Stage bar", () => {
    setup({ role: "viewer" });
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("gives an editor Edit and Review", async () => {
    setup({ role: "editor" });
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
