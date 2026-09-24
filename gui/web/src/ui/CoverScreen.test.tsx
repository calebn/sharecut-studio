import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { CoverScreen } from "./CoverScreen";

describe("CoverScreen", () => {
  it("renders a heading, body, and shell classes with accessible markup", async () => {
    const { container } = render(
      <CoverScreen
        heading="Room full"
        shellClassName="review-shell record-shell"
      >
        <p>Try another room.</p>
      </CoverScreen>,
    );

    expect(screen.getByRole("main")).toHaveClass(
      "cover",
      "review-shell",
      "record-shell",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Room full",
    );
    expect(screen.getByText("Try another room.")).toBeInTheDocument();
    expect(
      container.querySelector(".cover > .cover-center.center.stack"),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("supports status-only screens without inventing a heading", () => {
    render(
      <CoverScreen>
        <p role="status">Loading…</p>
      </CoverScreen>,
    );

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });
});
