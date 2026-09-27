import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { CommentCompose } from "./CommentCompose";

describe("CommentCompose", () => {
  it("names the body field without depending on placeholder and passes axe", async () => {
    const { container } = render(
      <CommentCompose body="" onBodyChange={() => {}} onSubmit={() => {}} />,
    );
    expect(
      screen.getByRole("textbox", { name: "Comment" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
