import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { StyleGuide } from "./StyleGuide";

describe("StyleGuide", () => {
  it("offers working in-page navigation and named catalog links; axe-clean", async () => {
    const { container } = render(<StyleGuide />);
    const navigation = screen.getByRole("navigation", {
      name: "Style guide sections",
    });
    for (const link of within(navigation).getAllByRole("link")) {
      const href = link.getAttribute("href");
      expect(href).toMatch(/^#/);
      expect(href && container.querySelector(href)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Bounce dialog" })).toHaveAttribute(
      "href",
      "./?path=/docs/templates-bouncedialog--docs",
    );
    await expectNoA11yViolations(container);
  });

  it("demonstrates selection and action feedback without app state", async () => {
    const user = userEvent.setup();
    render(<StyleGuide />);
    const toggle = screen.getByRole("button", { name: "Select example" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    const quiet = screen.getByRole("button", { name: "Quiet tab example" });
    await user.click(quiet);
    expect(quiet).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Save example" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "No project data changed.",
    );
    expect(screen.getByRole("button", { name: "Unavailable" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Episode name" }),
    ).toHaveAccessibleDescription(
      "A label identifies the control; a hint adds useful context.",
    );
    await user.clear(screen.getByRole("textbox", { name: "Episode name" }));
    await user.type(
      screen.getByRole("textbox", { name: "Episode name" }),
      "New title",
    );
    expect(screen.getByRole("textbox", { name: "Episode name" })).toHaveValue(
      "New title",
    );
  });
});
