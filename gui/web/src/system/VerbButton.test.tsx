import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerbButton } from "./VerbButton";

describe("VerbButton", () => {
  it("prints a caption as one hidden word inside the button", () => {
    render(<VerbButton verb="comment" caption="Comment" />);
    const button = screen.getByRole("button", { name: "Comment" });
    const labels = button.querySelectorAll(".sys-dock-label");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toHaveTextContent("Comment");
    expect(labels[0]).toHaveAttribute("aria-hidden", "true");
  });

  it("without a caption renders no label", () => {
    render(<VerbButton verb="comment" />);
    expect(
      screen
        .getByRole("button", { name: "Comment" })
        .querySelector(".sys-dock-label"),
    ).toBeNull();
  });
});
