import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Cover } from "./Cover";

describe("Cover", () => {
  it.each([
    ["page", 1],
    ["region", 0],
  ] as const)("a %s cover shows the brand mark %i time(s)", (size, marks) => {
    const { container } = render(
      <Cover size={size} glyph="eye-off" title="Title">
        Body.
      </Cover>,
    );
    expect(container.querySelectorAll(".brand-symbol")).toHaveLength(marks);
    expect(container.querySelector(".sys-cover")).toHaveClass(
      `sys-cover--${size}`,
    );
  });

  it("fires the primary and secondary actions and renders extra", async () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    render(
      <Cover
        size="region"
        glyph="eye-off"
        title="Title"
        primary={{ label: "Go", onClick: primary }}
        secondary={{ label: "Later", onClick: secondary }}
        extra={<span>Rosa and Jon</span>}
      >
        Body.
      </Cover>,
    );
    expect(screen.getByText("Rosa and Jon")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(secondary).toHaveBeenCalledOnce();
    expect(primary).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(primary).toHaveBeenCalledOnce();
  });

  it("renders no action row without actions", () => {
    const { container } = render(
      <Cover size="region" glyph="eye-off" title="Title">
        Body.
      </Cover>,
    );
    expect(container.querySelector(".sys-cover-actions")).toBeNull();
  });
});
