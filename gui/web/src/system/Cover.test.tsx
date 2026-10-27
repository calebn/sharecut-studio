import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
